#include "lm_disk.h"

#include "lm.h"
#include "lm_fixture.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/fiemap.h>
#include <linux/fs.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>

/* statx with the kernel's own layout (linux/stat.h, 6.1), so the direct-I/O
 * alignment and the mount id do not depend on how new the C library's
 * headers are. */
struct lm_statx_timestamp {
    int64_t tv_sec;
    uint32_t tv_nsec;
    int32_t reserved;
};

struct lm_statx {
    uint32_t stx_mask;
    uint32_t stx_blksize;
    uint64_t stx_attributes;
    uint32_t stx_nlink;
    uint32_t stx_uid;
    uint32_t stx_gid;
    uint16_t stx_mode;
    uint16_t spare0;
    uint64_t stx_ino;
    uint64_t stx_size;
    uint64_t stx_blocks;
    uint64_t stx_attributes_mask;
    struct lm_statx_timestamp stx_atime, stx_btime, stx_ctime, stx_mtime;
    uint32_t stx_rdev_major, stx_rdev_minor;
    uint32_t stx_dev_major, stx_dev_minor;
    uint64_t stx_mnt_id;
    uint32_t stx_dio_mem_align;
    uint32_t stx_dio_offset_align;
    uint64_t spare3[12];
};

_Static_assert(sizeof(struct lm_statx) == 256, "struct statx is 256 bytes");

#define LM_STATX_BASIC_STATS 0x07ffU
#define LM_STATX_BTIME 0x0800U
#define LM_STATX_MNT_ID 0x1000U
#define LM_STATX_DIOALIGN 0x2000U
#define LM_AT_EMPTY_PATH 0x1000

static const char *const STAT_NAMES[LM_DISK_STAT_FIELDS] = {
    "reads", "read_merges", "read_sectors", "read_ticks_ms",
    "writes", "write_merges", "write_sectors", "write_ticks_ms",
    "in_flight", "io_ticks_ms", "time_in_queue_ms",
    "discards", "discard_merges", "discard_sectors", "discard_ticks_ms",
    "flushes", "flush_ticks_ms",
};
#define STAT_IN_FLIGHT 8

static void copy(char *dst, size_t size, const char *src) {
    snprintf(dst, size, "%s", src);
}

/* A sysfs file's first line, trimmed of surrounding blanks; false when absent. */
static bool read_line(const char *path, char *buf, size_t size) {
    FILE *f = fopen(path, "r");
    if (f == NULL) return false;
    bool ok = fgets(buf, (int)size, f) != NULL;
    fclose(f);
    if (!ok) return false;
    size_t len = strlen(buf);
    while (len > 0 && isspace((unsigned char)buf[len - 1])) buf[--len] = '\0';
    size_t start = 0;
    while (buf[start] != '\0' && isspace((unsigned char)buf[start])) start++;
    if (start > 0) memmove(buf, buf + start, len - start + 1);
    return true;
}

static int lm_statx(int fd, unsigned mask, struct lm_statx *sx) {
    memset(sx, 0, sizeof(*sx));
    return (int)syscall(SYS_statx, fd, "", LM_AT_EMPTY_PATH, mask, sx);
}

/* Undoes mountinfo's octal escapes (\040 for a space) in place. */
static void unescape(char *s) {
    char *out = s;
    for (char *p = s; *p; p++) {
        if (p[0] == '\\' && p[1] >= '0' && p[1] <= '3' && p[2] >= '0' && p[2] <= '7' && p[3] >= '0' && p[3] <= '7') {
            *out++ = (char)((p[1] - '0') * 64 + (p[2] - '0') * 8 + (p[3] - '0'));
            p += 3;
        } else {
            *out++ = *p;
        }
    }
    *out = '\0';
}

/* Whether `path` is `dir` or lies under it. */
static size_t under(const char *path, const char *dir) {
    size_t n = strlen(dir);
    if (n == 1 && dir[0] == '/') return 1;
    if (strncmp(path, dir, n) != 0) return 0;
    return (path[n] == '\0' || path[n] == '/') ? n : 0;
}

/* The mountinfo line of the file's mount: by mount id when statx gives it,
 * otherwise the longest mount point above the file among the mounts of its
 * device. */
static void find_mount(lm_disk *d, bool have_mnt_id, uint64_t mnt_id) {
    FILE *f = fopen("/proc/self/mountinfo", "r");
    if (f == NULL) return;
    char line[8192];
    size_t best = 0;
    while (fgets(line, sizeof(line), f) != NULL) {
        line[strcspn(line, "\n")] = '\0';
        char *fields[64];
        int n = 0;
        for (char *save = NULL, *tok = strtok_r(line, " ", &save); tok != NULL && n < 64; tok = strtok_r(NULL, " ", &save)) fields[n++] = tok;
        int dash = -1;
        for (int i = 6; i < n; i++) {
            if (strcmp(fields[i], "-") == 0) {
                dash = i;
                break;
            }
        }
        if (n < 6 || dash < 0 || dash + 3 > n) continue;
        unsigned major = 0, minor = 0;
        if (sscanf(fields[2], "%u:%u", &major, &minor) != 2) continue;
        uint64_t id = strtoull(fields[0], NULL, 10);
        char point[PATH_MAX];
        copy(point, sizeof(point), fields[4]);
        unescape(point);
        size_t score;
        if (have_mnt_id) {
            if (id != mnt_id) continue;
            score = SIZE_MAX;
        } else {
            if (major != d->file_major || minor != d->file_minor) continue;
            score = under(d->file_path, point);
            if (score == 0 || score <= best) continue;
        }
        best = score;
        d->mount_found = true;
        d->mount_id = id;
        copy(d->mount_point, sizeof(d->mount_point), point);
        copy(d->mount_options, sizeof(d->mount_options), fields[5]);
        copy(d->fs_type, sizeof(d->fs_type), fields[dash + 1]);
        copy(d->mount_source, sizeof(d->mount_source), fields[dash + 2]);
        unescape(d->mount_source);
        copy(d->super_options, sizeof(d->super_options), dash + 3 < n ? fields[dash + 3] : "");
        if (have_mnt_id) break;
    }
    fclose(f);
}

/* Fills the device names from /sys/dev/block/<major>:<minor>; false when the
 * kernel has no block device by that number. */
static bool device_by_number(lm_disk *d, unsigned major, unsigned minor) {
    char link[PATH_MAX], target[PATH_MAX];
    snprintf(link, sizeof(link), "/sys/dev/block/%u:%u", major, minor);
    char *resolved = realpath(link, target);
    if (resolved == NULL) return false;
    const char *name = strrchr(target, '/');
    if (name == NULL) return false;
    copy(d->block_device, sizeof(d->block_device), name + 1);
    char partition[PATH_MAX + 16];
    snprintf(partition, sizeof(partition), "%s/partition", target);
    if (access(partition, F_OK) == 0) {
        /* A partition's directory sits inside its disk's. */
        char parent[PATH_MAX];
        copy(parent, sizeof(parent), target);
        char *slash = strrchr(parent, '/');
        if (slash == NULL) return false;
        *slash = '\0';
        const char *disk = strrchr(parent, '/');
        if (disk == NULL) return false;
        copy(d->disk_device, sizeof(d->disk_device), disk + 1);
        snprintf(d->part_sys, sizeof(d->part_sys), "/sys/class/block/%s", d->block_device);
    } else {
        copy(d->disk_device, sizeof(d->disk_device), d->block_device);
        d->part_sys[0] = '\0';
    }
    snprintf(d->disk_sys, sizeof(d->disk_sys), "/sys/class/block/%s", d->disk_device);
    return true;
}

void lm_disk_find(lm_disk *d, int fd) {
    memset(d, 0, sizeof(*d));
    d->fd = fd;
    d->device_from = "none";
    char proc[64];
    snprintf(proc, sizeof(proc), "/proc/self/fd/%d", fd);
    ssize_t n = readlink(proc, d->file_path, sizeof(d->file_path) - 1);
    if (n < 0) lm_die("readlink %s: %s", proc, strerror(errno));
    d->file_path[n] = '\0';

    struct stat st;
    if (fstat(fd, &st) != 0) lm_die("fstat: %s", strerror(errno));
    d->file_major = major(st.st_dev);
    d->file_minor = minor(st.st_dev);

    struct lm_statx sx;
    bool have_mnt_id = lm_statx(fd, LM_STATX_MNT_ID, &sx) == 0 && (sx.stx_mask & LM_STATX_MNT_ID);
    find_mount(d, have_mnt_id, sx.stx_mnt_id);

    if (device_by_number(d, d->file_major, d->file_minor)) {
        d->device_found = true;
        d->device_from = "st_dev";
    } else if (d->mount_found && strncmp(d->mount_source, "/dev/", 5) == 0) {
        /* A file system that gives files a device number of its own (btrfs,
         * overlayfs over a block device): the mount's source names the device. */
        struct stat source;
        if (stat(d->mount_source, &source) == 0 && S_ISBLK(source.st_mode) &&
            device_by_number(d, major(source.st_rdev), minor(source.st_rdev))) {
            d->device_found = true;
            d->device_from = "mount_source";
        }
    }
}

static bool is_number(const char *s) {
    if (*s == '\0') return false;
    for (; *s; s++) if (!isdigit((unsigned char)*s)) return false;
    return true;
}

/* A sysfs value as a number when it is one, as a string otherwise; nothing when absent. */
static void sys_member(lm_event *e, const char *key, const char *dir, const char *file) {
    char path[PATH_MAX + 64], value[512];
    snprintf(path, sizeof(path), "%s/%s", dir, file);
    if (!read_line(path, value, sizeof(value))) return;
    if (is_number(value)) lm_event_u64(e, key, strtoull(value, NULL, 10));
    else lm_event_str(e, key, value);
}

/* A sysfs value as a string always (a model, a serial, a firmware revision,
 * which may happen to be digits); nothing when absent. */
static void sys_member_str(lm_event *e, const char *key, const char *dir, const char *file) {
    char path[PATH_MAX + 64], value[512];
    snprintf(path, sizeof(path), "%s/%s", dir, file);
    if (read_line(path, value, sizeof(value))) lm_event_str(e, key, value);
}

static void rfc3339(char *buf, size_t size, int64_t sec, uint32_t nsec) {
    time_t t = (time_t)sec;
    struct tm utc;
    if (gmtime_r(&t, &utc) == NULL) {
        copy(buf, size, "unknown");
        return;
    }
    char date[32];
    strftime(date, sizeof(date), "%Y-%m-%dT%H:%M:%S", &utc);
    snprintf(buf, size, "%s.%09uZ", date, nsec);
}

void lm_disk_observe(const lm_disk *d, lm_event *e, uint64_t length) {
    char text[PATH_MAX + 64];
    lm_event_str(e, "file_path", d->file_path);
    snprintf(text, sizeof(text), "%u:%u", d->file_major, d->file_minor);
    lm_event_str(e, "file_device", text);
    lm_event_bool(e, "device_found", d->device_found);
    lm_event_str(e, "device_from", d->device_from);
    if (d->device_found) {
        lm_event_str(e, "block_device", d->block_device);
        lm_event_str(e, "disk_device", d->disk_device);
        char device_link[PATH_MAX + 16], controller[PATH_MAX];
        snprintf(device_link, sizeof(device_link), "%s/device", d->disk_sys);
        if (realpath(device_link, controller) != NULL) {
            const char *name = strrchr(controller, '/');
            lm_event_str(e, "disk_controller", name ? name + 1 : controller);
        }
        sys_member_str(e, "disk_model", d->disk_sys, "device/model");
        sys_member_str(e, "disk_serial", d->disk_sys, "device/serial");
        sys_member_str(e, "disk_firmware", d->disk_sys, "device/firmware_rev");
        char size[64], path[PATH_MAX + 16];
        snprintf(path, sizeof(path), "%s/size", d->disk_sys);
        if (read_line(path, size, sizeof(size)) && is_number(size)) lm_event_u64(e, "disk_bytes", strtoull(size, NULL, 10) * 512ULL);
        static const char *const QUEUE[] = {
            "logical_block_size", "physical_block_size", "write_cache", "fua", "max_sectors_kb", "max_hw_sectors_kb",
            "read_ahead_kb", "nr_requests", "scheduler", "rotational", "nomerges",
        };
        for (size_t i = 0; i < sizeof(QUEUE) / sizeof(QUEUE[0]); i++) {
            char file[64];
            snprintf(file, sizeof(file), "queue/%s", QUEUE[i]);
            sys_member(e, QUEUE[i], d->disk_sys, file);
        }
    }
    if (d->mount_found) {
        lm_event_str(e, "fs_type", d->fs_type);
        lm_event_str(e, "mount_point", d->mount_point);
        lm_event_str(e, "mount_source", d->mount_source);
        lm_event_str(e, "mount_options", d->mount_options);
        lm_event_str(e, "super_options", d->super_options);
    }

    int flags = fcntl(d->fd, F_GETFL);
    if (flags < 0) lm_die("fcntl(F_GETFL): %s", strerror(errno));
    lm_event_bool(e, "o_direct", (flags & O_DIRECT) != 0);

    struct lm_statx sx;
    if (lm_statx(d->fd, LM_STATX_BASIC_STATS | LM_STATX_BTIME | LM_STATX_DIOALIGN, &sx) == 0) {
        snprintf(text, sizeof(text), "0x%x", sx.stx_mask);
        lm_event_str(e, "statx_mask", text);
        if (sx.stx_mask & LM_STATX_DIOALIGN) {
            lm_event_u64(e, "dio_offset_align", sx.stx_dio_offset_align);
            lm_event_u64(e, "dio_mem_align", sx.stx_dio_mem_align);
        }
        rfc3339(text, sizeof(text), sx.stx_mtime.tv_sec, sx.stx_mtime.tv_nsec);
        lm_event_str(e, "file_mtime", text);
        if (sx.stx_mask & LM_STATX_BTIME) {
            rfc3339(text, sizeof(text), sx.stx_btime.tv_sec, sx.stx_btime.tv_nsec);
            lm_event_str(e, "file_birth", text);
        }
    }

    uint64_t bytes = lm_file_bytes(d->fd);
    if (length == 0) length = bytes;
    lm_event_u64(e, "file_bytes", bytes);
    lm_file_extents x = lm_file_extents_of(d->fd, length);
    lm_event_bool(e, "fiemap", x.ok);
    if (x.ok) {
        lm_event_u64(e, "file_extents", x.extents);
        lm_event_u64(e, "file_unwritten_extents", x.unwritten_extents);
        lm_event_u64(e, "file_delalloc_extents", x.delalloc_extents);
        lm_event_u64(e, "file_mapped_bytes", x.mapped_bytes);
    }
    int64_t resident = lm_file_resident_pages(d->fd, length);
    if (resident >= 0) lm_event_u64(e, "file_resident_pages", (uint64_t)resident);
    lm_event_u64(e, "page_bytes", (uint64_t)sysconf(_SC_PAGESIZE));
}

static int read_stat(const char *path, uint64_t *v) {
    FILE *f = fopen(path, "r");
    if (f == NULL) return 0;
    int n = 0;
    while (n < LM_DISK_STAT_FIELDS && fscanf(f, "%" SCNu64, &v[n]) == 1) n++;
    fclose(f);
    return n;
}

void lm_disk_stat_read(const lm_disk *d, lm_disk_stat *s) {
    memset(s, 0, sizeof(*s));
    if (!d->device_found) return;
    char path[PATH_MAX + 16];
    snprintf(path, sizeof(path), "%s/stat", d->disk_sys);
    s->n = read_stat(path, s->v);
    s->ok = s->n >= 11;
    if (d->part_sys[0] != '\0') {
        snprintf(path, sizeof(path), "%s/stat", d->part_sys);
        s->part_n = read_stat(path, s->part);
        s->part_ok = s->part_n >= 11;
    }
}

static void counters(lm_event *e, int n, const uint64_t *before, const uint64_t *after) {
    lm_event_object(e, "change");
    for (int i = 0; i < n; i++) {
        if (i == STAT_IN_FLIGHT) continue;
        lm_event_u64(e, STAT_NAMES[i], after[i] - before[i]);
    }
    lm_event_close(e);
    if (n > STAT_IN_FLIGHT) {
        lm_event_u64(e, "in_flight_before", before[STAT_IN_FLIGHT]);
        lm_event_u64(e, "in_flight_after", after[STAT_IN_FLIGHT]);
    }
    lm_event_array(e, "before");
    for (int i = 0; i < n; i++) lm_event_u64(e, NULL, before[i]);
    lm_event_close(e);
    lm_event_array(e, "after");
    for (int i = 0; i < n; i++) lm_event_u64(e, NULL, after[i]);
    lm_event_close(e);
}

void lm_disk_counters_emit(const lm_disk *d, const lm_disk_stat *before, const lm_disk_stat *after, const char *interval, uint64_t length) {
    lm_event e;
    lm_event_begin(&e, "device_counters", lm_now_ns());
    lm_event_str(&e, "interval", interval);
    lm_event_bool(&e, "device_found", d->device_found && before->ok && after->ok);
    if (d->device_found && before->ok && after->ok) {
        char path[PATH_MAX + 16];
        snprintf(path, sizeof(path), "%s/stat", d->disk_sys);
        lm_event_str(&e, "disk_device", d->disk_device);
        lm_event_str(&e, "stat", path);
        int n = before->n < after->n ? before->n : after->n;
        counters(&e, n, before->v, after->v);
        if (before->part_ok && after->part_ok) {
            lm_event_object(&e, "partition");
            lm_event_str(&e, "block_device", d->block_device);
            snprintf(path, sizeof(path), "%s/stat", d->part_sys);
            lm_event_str(&e, "stat", path);
            int pn = before->part_n < after->part_n ? before->part_n : after->part_n;
            counters(&e, pn, before->part, after->part);
            lm_event_close(&e);
        }
    }
    if (length == 0) length = lm_file_bytes(d->fd);
    int64_t resident = lm_file_resident_pages(d->fd, length);
    if (resident >= 0) lm_event_u64(&e, "file_resident_pages", (uint64_t)resident);
    lm_event_emit(&e);
}

lm_file_extents lm_file_extents_of(int fd, uint64_t length) {
    lm_file_extents x = { 0 };
    enum { BATCH = 256 };
    size_t size = sizeof(struct fiemap) + BATCH * sizeof(struct fiemap_extent);
    struct fiemap *map = calloc(1, size);
    if (map == NULL) lm_die("calloc");
    uint64_t start = 0;
    for (;;) {
        memset(map, 0, size);
        map->fm_start = start;
        map->fm_length = length - start;
        map->fm_extent_count = BATCH;
        if (ioctl(fd, FS_IOC_FIEMAP, map) != 0) {
            int error = errno;
            free(map);
            if (error == EOPNOTSUPP || error == ENOTTY) {
                x.unsupported = true;
                return x;
            }
            lm_die("FIEMAP: %s", strerror(error));
        }
        if (map->fm_mapped_extents == 0) break;
        bool last = false;
        for (unsigned i = 0; i < map->fm_mapped_extents; i++) {
            const struct fiemap_extent *ext = &map->fm_extents[i];
            x.extents++;
            if (ext->fe_flags & FIEMAP_EXTENT_UNWRITTEN) x.unwritten_extents++;
            if (ext->fe_flags & FIEMAP_EXTENT_DELALLOC) x.delalloc_extents++;
            uint64_t from = ext->fe_logical < start ? start : ext->fe_logical;
            uint64_t to = ext->fe_logical + ext->fe_length;
            if (to > length) to = length;
            if (to > from) x.mapped_bytes += to - from;
            if (ext->fe_flags & FIEMAP_EXTENT_LAST) last = true;
            start = ext->fe_logical + ext->fe_length;
        }
        if (last || start >= length) break;
    }
    free(map);
    x.ok = true;
    return x;
}

int64_t lm_file_resident_pages(int fd, uint64_t length) {
    if (length == 0) return 0;
    long page = sysconf(_SC_PAGESIZE);
    void *addr = mmap(NULL, length, PROT_READ, MAP_SHARED, fd, 0);
    if (addr == MAP_FAILED) return -1;
    size_t pages = (size_t)((length + (uint64_t)page - 1) / (uint64_t)page);
    unsigned char *vec = malloc(pages);
    int64_t resident = -1;
    if (vec != NULL && mincore(addr, length, vec) == 0) {
        resident = 0;
        for (size_t i = 0; i < pages; i++) resident += vec[i] & 1;
    }
    free(vec);
    munmap(addr, length);
    return resident;
}

uint64_t lm_file_bytes(int fd) {
    struct stat st;
    if (fstat(fd, &st) != 0) lm_die("fstat: %s", strerror(errno));
    return (uint64_t)st.st_size;
}

void lm_pread_exact(int fd, void *buf, uint64_t len, uint64_t offset, const char *what) {
    uint64_t done = 0;
    while (done < len) {
        ssize_t n = pread(fd, (char *)buf + done, len - done, (off_t)(offset + done));
        if (n < 0) {
            if (errno == EINTR) continue;
            lm_die("%s: pread of %" PRIu64 " bytes at %" PRIu64 ": %s", what, len - done, offset + done, strerror(errno));
        }
        if (n == 0) lm_die("%s: end of file at %" PRIu64 ", reading %" PRIu64 " bytes at %" PRIu64, what, offset + done, len, offset);
        done += (uint64_t)n;
    }
}

int lm_fixture_open(const char *dir, int flags, char *path, unsigned long path_size) {
    int n = snprintf(path, path_size, "%s/%s", dir, LM_FIXTURE_NAME);
    if (n < 0 || (unsigned long)n >= path_size) lm_usage("parameter dir is too long: %s", dir);
    int fd = open(path, flags);
    if (fd < 0) {
        lm_die("cannot open the Fixture %s%s: %s. The box makes it at boot (runner/provision.py, with runner/fixture.c); "
               "nothing here makes or repairs it",
               path, (flags & O_DIRECT) ? " with O_DIRECT" : "", strerror(errno));
    }
    return fd;
}

void lm_fixture_check(int fd, uint64_t span, uint64_t block, void *buf) {
    uint64_t bytes = lm_file_bytes(fd);
    if (bytes < span) lm_die("the Fixture holds %" PRIu64 " bytes, fewer than the span of %" PRIu64, bytes, span);
    if (span < block || span % block != 0) lm_die("the span of %" PRIu64 " bytes is not a whole number of %" PRIu64 "-byte blocks", span, block);
    lm_file_extents x = lm_file_extents_of(fd, span);
    if (x.ok && x.unwritten_extents != 0) lm_die("the Fixture has %" PRIu64 " unwritten extents in its span: reads of them would return zeros without touching the device", x.unwritten_extents);
    if (x.ok && x.delalloc_extents != 0) lm_die("the Fixture has %" PRIu64 " extents not yet allocated on the device", x.delalloc_extents);
    if (x.ok && x.mapped_bytes != span) lm_die("extents cover %" PRIu64 " of the span's %" PRIu64 " bytes: the Fixture has holes", x.mapped_bytes, span);
    uint64_t blocks = span / block;
    const uint64_t checked[3] = { 0, blocks / 2, blocks - 1 };
    for (int i = 0; i < 3; i++) {
        uint64_t offset = checked[i] * block;
        lm_pread_exact(fd, buf, block, offset, "checking the Fixture");
        const uint64_t *words = (const uint64_t *)buf;
        for (uint64_t w = 0; w < block / 8; w++) {
            uint64_t want = lm_fixture_word(offset + w * 8);
            if (words[w] != want) {
                lm_die("the Fixture's word at byte %" PRIu64 " is 0x%016" PRIx64 ", not the pattern's 0x%016" PRIx64, offset + w * 8, words[w], want);
            }
        }
    }
}

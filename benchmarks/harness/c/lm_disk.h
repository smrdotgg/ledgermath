#ifndef LEDGERMATH_LM_DISK_H
#define LEDGERMATH_LM_DISK_H

/* What a disk benchmark observes about the file it opened and the device
 * behind it, for the C harness. Shared by the four disk benchmarks.
 *
 * A parameter set names its disk twice: `disk` (root_volume or
 * instance_store), which makes the Series, and `dir`, where the binary
 * works. The binary never reads `disk`. It opens a file under `dir` and
 * reports what it found there: the device the file's st_dev names, the whole
 * disk that device belongs to, that disk's model and serial, the mount and its
 * options, the direct-I/O state of the descriptor, the queue settings, and the
 * file's extents and page-cache residency. Matching a model string to a name
 * is a Method's work, not the binary's.
 *
 *     lm_disk d;
 *     lm_disk_find(&d, fd);                  // never exits: a file on no block device is reported as such
 *     lm_event e;
 *     lm_observed_begin(&e, lm_now_ns());
 *     lm_disk_observe(&d, &e, span);         // the device and file members
 *     lm_event_u64(&e, "request_bytes", 8192);
 *     lm_event_emit(&e);
 *
 *     lm_disk_stat before, after;
 *     lm_disk_stat_read(&d, &before);
 *     lm_measure(fn, ctx);
 *     lm_disk_stat_read(&d, &after);
 *     lm_disk_counters_emit(&d, &before, &after, "lm_measure", span);
 *
 * `device_counters` is the change in /sys/block/<disk>/stat over the
 * interval it names: the proof that the device, not the page cache, served
 * the reads (read sectors x 512 against repetitions x request bytes), and of
 * how many writes and flushes a durable write cost.
 *
 * Everything here runs outside measured intervals.
 */

#include <limits.h>
#include <stdbool.h>
#include <stdint.h>

#include "lm_event.h"

#define LM_DISK_STAT_FIELDS 17

typedef struct {
    int fd;
    char file_path[PATH_MAX];      /* readlink of /proc/self/fd/<fd> */
    unsigned file_major, file_minor; /* the file's st_dev */
    bool device_found;             /* a block device in /sys for the file */
    const char *device_from;       /* "st_dev" or "mount_source": how it was found */
    char block_device[64];         /* its kernel name: a partition or a whole disk */
    char disk_device[64];          /* the whole disk */
    char disk_sys[PATH_MAX];       /* /sys/class/block/<disk_device> */
    char part_sys[PATH_MAX];       /* /sys/class/block/<block_device> when it is a partition, else "" */
    bool mount_found;
    uint64_t mount_id;
    char mount_point[PATH_MAX];
    char mount_options[512];
    char fs_type[64];
    char mount_source[PATH_MAX];
    char super_options[1024];
} lm_disk;

typedef struct {
    bool ok;
    int n;                         /* fields read: 17 on the box's kernel */
    uint64_t v[LM_DISK_STAT_FIELDS];
    bool part_ok;
    int part_n;
    uint64_t part[LM_DISK_STAT_FIELDS];
} lm_disk_stat;

typedef struct {
    bool ok;                       /* FIEMAP answered */
    bool unsupported;              /* the file system does not map extents (tmpfs) */
    uint64_t extents;
    uint64_t unwritten_extents;
    uint64_t delalloc_extents;
    uint64_t mapped_bytes;         /* bytes of [0, length) that extents cover */
} lm_file_extents;

/* Finds the device and the mount behind the open file `fd`. */
void lm_disk_find(lm_disk *d, int fd);

/* Adds the device's and the file's members to an event (an `observed`, as a
 * rule): each disk benchmark's README lists the keys.
 * `length` is the part of the file the benchmark uses, for extents and
 * residency; 0 means the whole file. */
void lm_disk_observe(const lm_disk *d, lm_event *e, uint64_t length);

/* Reads /sys/class/block/<disk>/stat (and the partition's, if any). */
void lm_disk_stat_read(const lm_disk *d, lm_disk_stat *s);

/* Emits `device_counters`: the change between two reads, both reads raw, and
 * the file's resident pages now. `interval` names what lay between them. */
void lm_disk_counters_emit(const lm_disk *d, const lm_disk_stat *before, const lm_disk_stat *after, const char *interval, uint64_t length);

/* The file's extents over [0, length), by FIEMAP. Exits 1 when FIEMAP fails
 * other than by being unsupported. */
lm_file_extents lm_file_extents_of(int fd, uint64_t length);

/* Pages of [0, length) in the page cache, by mincore; -1 when it cannot tell. */
int64_t lm_file_resident_pages(int fd, uint64_t length);

/* The file's size, by fstat; exits 1 when it cannot. */
uint64_t lm_file_bytes(int fd);

/* Reads exactly `len` bytes at `offset`, retrying short reads and EINTR;
 * exits 1 on an error or end of file. Outside measured intervals only. */
void lm_pread_exact(int fd, void *buf, uint64_t len, uint64_t offset, const char *what);

/* Opens LM_FIXTURE_NAME under `dir` with `flags`, exiting 1, saying why and
 * where the Fixture comes from, when it cannot. */
int lm_fixture_open(const char *dir, int flags, char *path, unsigned long path_size);

/* Checks the Fixture before measuring and exits 1 on any mismatch: its size is
 * at least `span`, extents cover all of [0, span) with none unwritten, and the
 * first, middle and last `block`-byte block of the span holds the pattern,
 * every word. On a file system without FIEMAP (tmpfs) the extent check cannot
 * be made and is skipped: the checksum after measuring is the proof that every
 * read returned the Fixture, there as everywhere. `buf` is an aligned buffer of `block` bytes; reads go
 * through `fd` (O_DIRECT for the direct-I/O benchmarks). */
void lm_fixture_check(int fd, uint64_t span, uint64_t block, void *buf);

#endif /* LEDGERMATH_LM_DISK_H */

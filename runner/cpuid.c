/* Prints what the `cpuid` instruction reports on every CPU this process may run
 * on, raw and unmasked, in the format of `cpuid -r`:
 *
 *     CPU 0:
 *        0x00000000 0x00: eax=0x0000001b ebx=0x756e6547 ecx=0x6c65746e edx=0x49656e69
 *
 * It covers every basic leaf, the hypervisor leaves, and every extended leaf,
 * with the sub-leaves each leaf defines. Part of the environment dump the
 * runner takes around every Run. It interprets nothing.
 */

#define _GNU_SOURCE

#if !defined(__x86_64__) && !defined(__i386__)
#error "cpuid.c is for x86; another architecture needs its own dump"
#endif

#include <cpuid.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

typedef struct {
    uint32_t eax, ebx, ecx, edx;
} regs_t;

static regs_t query(uint32_t leaf, uint32_t subleaf) {
    regs_t r;
    __cpuid_count(leaf, subleaf, r.eax, r.ebx, r.ecx, r.edx);
    return r;
}

static regs_t show(uint32_t leaf, uint32_t subleaf) {
    regs_t r = query(leaf, subleaf);
    printf("   0x%08x 0x%02x: eax=0x%08x ebx=0x%08x ecx=0x%08x edx=0x%08x\n",
           leaf, subleaf, r.eax, r.ebx, r.ecx, r.edx);
    return r;
}

static int all_zero(regs_t r) { return (r.eax | r.ebx | r.ecx | r.edx) == 0; }

/* Sub-leaves 0..max, where sub-leaf 0 reports max in EAX. */
static void counted_in_eax(uint32_t leaf) {
    regs_t first = show(leaf, 0);
    uint32_t max = first.eax > 0xFF ? 0xFF : first.eax;
    for (uint32_t i = 1; i <= max; i++) show(leaf, i);
}

static void show_leaf(uint32_t leaf) {
    regs_t r;
    switch (leaf) {
    case 0x04:       /* deterministic cache parameters: until cache type 0 */
    case 0x8000001D: /* the same, AMD */
        for (uint32_t i = 0; i < 64; i++) {
            r = show(leaf, i);
            if ((r.eax & 0x1F) == 0) break;
        }
        break;
    case 0x0B:       /* extended topology: until level type 0 */
    case 0x1F:
    case 0x80000026:
        for (uint32_t i = 0; i < 64; i++) {
            r = show(leaf, i);
            if (((r.ecx >> 8) & 0xFF) == 0) break;
        }
        break;
    case 0x0D: /* extended state: 0 and 1, then every component that exists */
        show(leaf, 0);
        show(leaf, 1);
        for (uint32_t i = 2; i < 64; i++) {
            if (!all_zero(query(leaf, i))) show(leaf, i);
        }
        break;
    case 0x0F: /* resource monitoring */
        show(leaf, 0);
        show(leaf, 1);
        break;
    case 0x10: /* resource allocation: one sub-leaf per bit set in EBX */
        r = show(leaf, 0);
        for (uint32_t i = 1; i < 32; i++) {
            if (r.ebx & (1u << i)) show(leaf, i);
        }
        break;
    case 0x12: /* SGX: 0 and 1, then enclave page cache sections until type 0 */
        show(leaf, 0);
        show(leaf, 1);
        for (uint32_t i = 2; i < 64; i++) {
            r = show(leaf, i);
            if ((r.eax & 0xF) == 0) break;
        }
        break;
    case 0x1B: /* PCONFIG: until type 0 */
        for (uint32_t i = 0; i < 64; i++) {
            r = show(leaf, i);
            if ((r.eax & 0xFFF) == 0) break;
        }
        break;
    case 0x07: /* structured extended features */
    case 0x14: /* processor trace */
    case 0x17: /* system-on-chip vendor */
    case 0x18: /* deterministic address translation */
    case 0x1D: /* tile information */
    case 0x20: /* history reset */
    case 0x24: /* AVX10 */
        counted_in_eax(leaf);
        break;
    case 0x23: /* performance monitoring: every sub-leaf that reports anything */
        show(leaf, 0);
        for (uint32_t i = 1; i < 32; i++) {
            if (!all_zero(query(leaf, i))) show(leaf, i);
        }
        break;
    default:
        show(leaf, 0);
        break;
    }
}

/* Every leaf from `base` to the maximum that leaf `base` reports in EAX. */
static void show_range(uint32_t base, uint32_t limit) {
    regs_t first = query(base, 0);
    uint32_t max = first.eax;
    if (max < base || max > limit) max = base; /* the range does not exist here */
    for (uint32_t leaf = base; leaf <= max; leaf++) show_leaf(leaf);
}

int main(void) {
    cpu_set_t allowed;
    if (sched_getaffinity(0, sizeof(allowed), &allowed) != 0) {
        perror("sched_getaffinity");
        return 1;
    }
    for (int cpu = 0; cpu < CPU_SETSIZE; cpu++) {
        if (!CPU_ISSET(cpu, &allowed)) continue;
        cpu_set_t one;
        CPU_ZERO(&one);
        CPU_SET(cpu, &one);
        if (sched_setaffinity(0, sizeof(one), &one) != 0) {
            perror("sched_setaffinity");
            return 1;
        }
        printf("CPU %d:\n", cpu);
        show_range(0x00000000, 0x0000FFFF);
        if (query(1, 0).ecx & (1u << 31)) show_range(0x40000000, 0x400000FF); /* a hypervisor is present */
        show_range(0x80000000, 0x8000FFFF);
    }
    return 0;
}

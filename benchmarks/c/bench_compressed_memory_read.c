#include "harness.h"

#include <stdio.h>
#include <stdlib.h>

#define NORMAL_BLOCKS 1000000ULL
#define QUICK_BLOCKS  100000ULL
#define BLOCK_LEN 256U
#define COMPRESSED_BYTES_PER_BLOCK 256U
#define DECOMPRESSED_BYTES_PER_OP (BLOCK_LEN * sizeof(uint32_t))

typedef struct {
    uint8_t *compressed;
    uint32_t out[BLOCK_LEN];
    uint64_t blocks;
    uint64_t index;
} compressed_ctx_t;

/* Cycle through a large pool of compressed blocks so we defeat the cache and measure
 * real unpack throughput rather than the same hot line repeatedly. */
__attribute__((noinline))
static uint64_t decompress_one_block(compressed_ctx_t *ctx) {
    uint8_t *in = ctx->compressed + ctx->index * COMPRESSED_BYTES_PER_BLOCK;
    uint64_t checksum = 0;
    for (uint32_t i = 0; i < BLOCK_LEN; i++) {
        uint32_t v = (uint32_t)in[i];
        ctx->out[i] = v;
        checksum += v;
    }
    ctx->index++;
    if (ctx->index == ctx->blocks) ctx->index = 0;
    return checksum;
}

static uint64_t compressed_run(void *arg) {
    return decompress_one_block((compressed_ctx_t *)arg);
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    uint64_t blocks = opts.quick ? QUICK_BLOCKS : NORMAL_BLOCKS;
    compressed_ctx_t comp = {0};
    comp.blocks = blocks;
    comp.compressed = (uint8_t *)xalloc(64, (size_t)blocks * COMPRESSED_BYTES_PER_BLOCK);
    for (uint64_t b = 0; b < blocks; b++) {
        uint8_t *block = comp.compressed + b * COMPRESSED_BYTES_PER_BLOCK;
        for (uint32_t i = 0; i < BLOCK_LEN; i++) block[i] = (uint8_t)i;
    }

    uint64_t comp_sum = decompress_one_block(&comp);
    if (comp_sum != 32640ULL) {
        fprintf(stderr, "error: decompression checksum validation failed\n");
        return 1;
    }
    for (uint32_t i = 0; i < BLOCK_LEN; i++) {
        if (comp.out[i] != i) {
            fprintf(stderr, "error: decompression output validation failed at %u\n", i);
            return 1;
        }
    }

    result_t results[1];
    results[0] = measure("compressed_memory_read", "bitpacker", 1, DECOMPRESSED_BYTES_PER_OP,
                         compressed_run, &comp, opts.samples, opts.target_calibration_ns);
    print_json(results, 1);

    free(comp.compressed);
    return 0;
}

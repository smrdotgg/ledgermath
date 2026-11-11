/* compressed_memory_read: unpack one block of 256 integers packed at 8 bits
 * each into 256 u32s, cycling through a pool of blocks larger than any cache.
 *
 * Parameters:
 *   LM_PARAM_BLOCKS  compressed blocks in the pool the repetitions cycle through
 *   LM_PARAM_BITS    bits per packed value; only 8 is implemented
 *
 * Observed:
 *   bytes_per_repetition             decompressed bytes one repetition writes
 *   compressed_bytes_per_repetition  compressed bytes one repetition reads
 *   blocks_verified                  blocks in the pool, each unpacked and checked at startup
 *   bits_per_value                   bits the largest value of a block needs, from the data
 *
 * The unpack loop is the one the July 2026 proof of concept ran, unchanged.
 */

#if !defined(__linux__) || !defined(__x86_64__)
#error "compressed_memory_read requires Linux x86_64"
#endif

#include "lm.h"

#include <stdlib.h>

#define BLOCK_LEN 256U
#define COMPRESSED_BYTES_PER_BLOCK 256U
#define DECOMPRESSED_BYTES_PER_BLOCK (BLOCK_LEN * sizeof(uint32_t))
#define BLOCK_SUM 32640ULL /* 0 + 1 + ... + 255 */

typedef struct {
    uint8_t *compressed;
    uint32_t out[BLOCK_LEN];
    uint64_t blocks;
    uint64_t index;
} compressed_ctx_t;

/* One repetition: unpack the next block of the pool. Cycling through the pool
 * keeps the compressed input out of cache. */
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

/* What bitpacking's num_bits computes: the bits the largest value needs. */
static unsigned num_bits(const uint32_t *values, size_t len) {
    uint32_t all = 0;
    for (size_t i = 0; i < len; i++) all |= values[i];
    return all == 0 ? 0U : 32U - (unsigned)__builtin_clz(all);
}

int main(int argc, char **argv) {
    lm_start(argc, argv);

    uint64_t blocks = lm_param_u64("blocks", "100000");
    uint64_t bits = lm_param_u64("bits", "8");
    if (blocks == 0) lm_usage("parameter blocks must be at least 1");
    if (bits != 8) lm_usage("parameter bits must be 8, the only width implemented, got %llu", (unsigned long long)bits);

    /* The block before packing: 0..255, as napkin-math's benchmark has it. */
    uint32_t source[BLOCK_LEN];
    for (uint32_t i = 0; i < BLOCK_LEN; i++) source[i] = i;
    unsigned source_bits = num_bits(source, BLOCK_LEN);
    if (source_bits != bits) lm_die("the block needs %u bits, not %llu", source_bits, (unsigned long long)bits);

    /* At 8 bits a value packs into one byte, so a compressed block is 256 bytes. */
    compressed_ctx_t ctx = {0};
    ctx.blocks = blocks;
    ctx.compressed = (uint8_t *)lm_alloc(64, (size_t)blocks * COMPRESSED_BYTES_PER_BLOCK);
    for (uint64_t b = 0; b < blocks; b++) {
        uint8_t *block = ctx.compressed + b * COMPRESSED_BYTES_PER_BLOCK;
        for (uint32_t i = 0; i < BLOCK_LEN; i++) block[i] = (uint8_t)source[i];
    }

    /* Every block of the pool unpacks to the source block; the index ends back at 0. */
    uint64_t verified = 0;
    unsigned unpacked_bits = 0;
    for (uint64_t b = 0; b < blocks; b++) {
        if (decompress_one_block(&ctx) != BLOCK_SUM) lm_die("block %llu unpacks to the wrong sum", (unsigned long long)b);
        for (uint32_t i = 0; i < BLOCK_LEN; i++) {
            if (ctx.out[i] != source[i]) lm_die("block %llu unpacks wrong at value %u", (unsigned long long)b, i);
        }
        unsigned block_bits = num_bits(ctx.out, BLOCK_LEN);
        if (block_bits > unpacked_bits) unpacked_bits = block_bits;
        verified++;
    }

    lm_observe_u64("bytes_per_repetition", DECOMPRESSED_BYTES_PER_BLOCK);
    lm_observe_u64("compressed_bytes_per_repetition", COMPRESSED_BYTES_PER_BLOCK);
    lm_observe_u64("blocks_verified", verified);
    lm_observe_u64("bits_per_value", unpacked_bits);
    lm_observed();

    lm_measure(compressed_run, &ctx);

    free(ctx.compressed);
    lm_finish();
    return 0;
}

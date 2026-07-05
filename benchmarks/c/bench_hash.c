#include "harness.h"

#include <immintrin.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#define HASH_BYTES 64U

typedef struct {
    uint8_t input[HASH_BYTES] __attribute__((aligned(64)));
} hash_ctx_t;

static uint32_t load_be32(const uint8_t *p) {
    return ((uint32_t)p[0] << 24) |
           ((uint32_t)p[1] << 16) |
           ((uint32_t)p[2] << 8) |
           (uint32_t)p[3];
}

static uint64_t load_be64(const uint8_t *p) {
    return ((uint64_t)load_be32(p) << 32) | (uint64_t)load_be32(p + 4);
}

static uint64_t load_le64(const uint8_t *p) {
    uint64_t v;
    memcpy(&v, p, sizeof(v));
    return v;
}

static void store_be32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)(v >> 24);
    p[1] = (uint8_t)(v >> 16);
    p[2] = (uint8_t)(v >> 8);
    p[3] = (uint8_t)v;
}

__attribute__((noinline, target("sse4.2")))
static uint64_t crc32c_hw64(const uint8_t *data) {
    uint64_t crc = 0;
    for (int i = 0; i < 8; i++) crc = _mm_crc32_u64(crc, load_le64(data + (size_t)i * 8));
    return crc & 0xffffffffULL;
}

static uint32_t crc32c_scalar(const uint8_t *data, size_t len) {
    uint32_t crc = 0;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            uint32_t mask = 0U - (crc & 1U);
            crc = (crc >> 1) ^ (0x82f63b78U & mask);
        }
    }
    return crc;
}

static uint64_t crc32_run(void *arg) {
    hash_ctx_t *ctx = (hash_ctx_t *)arg;
    return crc32c_hw64(ctx->input);
}

static inline uint64_t rotl64(uint64_t x, int b) {
    return (x << b) | (x >> (64 - b));
}

#define SIPROUND() do { \
    v0 += v1; v1 = rotl64(v1, 13); v1 ^= v0; v0 = rotl64(v0, 32); \
    v2 += v3; v3 = rotl64(v3, 16); v3 ^= v2; \
    v0 += v3; v3 = rotl64(v3, 21); v3 ^= v0; \
    v2 += v1; v1 = rotl64(v1, 17); v1 ^= v2; v2 = rotl64(v2, 32); \
} while (0)

/* Public-domain SipHash-1-3 shape: c=1 compression round, d=3 final rounds.
 * This is the DefaultHasher-family variant the Rust source was benchmarking. */
__attribute__((noinline))
static uint64_t siphash13_64(const uint8_t *data) {
    const uint64_t k0 = 0x0706050403020100ULL;
    const uint64_t k1 = 0x0f0e0d0c0b0a0908ULL;
    uint64_t v0 = 0x736f6d6570736575ULL ^ k0;
    uint64_t v1 = 0x646f72616e646f6dULL ^ k1;
    uint64_t v2 = 0x6c7967656e657261ULL ^ k0;
    uint64_t v3 = 0x7465646279746573ULL ^ k1;

    for (int i = 0; i < 8; i++) {
        uint64_t m = load_le64(data + (size_t)i * 8);
        v3 ^= m;
        SIPROUND();
        v0 ^= m;
    }

    uint64_t b = (uint64_t)HASH_BYTES << 56;
    v3 ^= b;
    SIPROUND();
    v0 ^= b;
    v2 ^= 0xff;
    SIPROUND();
    SIPROUND();
    SIPROUND();
    return v0 ^ v1 ^ v2 ^ v3;
}

#undef SIPROUND

static uint64_t siphash_run(void *arg) {
    hash_ctx_t *ctx = (hash_ctx_t *)arg;
    return siphash13_64(ctx->input);
}

static const uint32_t sha256_initial[8] = {
    0x6a09e667U, 0xbb67ae85U, 0x3c6ef372U, 0xa54ff53aU,
    0x510e527fU, 0x9b05688cU, 0x1f83d9abU, 0x5be0cd19U,
};

static const uint32_t sha256_k[64] = {
    0x428a2f98U, 0x71374491U, 0xb5c0fbcfU, 0xe9b5dba5U,
    0x3956c25bU, 0x59f111f1U, 0x923f82a4U, 0xab1c5ed5U,
    0xd807aa98U, 0x12835b01U, 0x243185beU, 0x550c7dc3U,
    0x72be5d74U, 0x80deb1feU, 0x9bdc06a7U, 0xc19bf174U,
    0xe49b69c1U, 0xefbe4786U, 0x0fc19dc6U, 0x240ca1ccU,
    0x2de92c6fU, 0x4a7484aaU, 0x5cb0a9dcU, 0x76f988daU,
    0x983e5152U, 0xa831c66dU, 0xb00327c8U, 0xbf597fc7U,
    0xc6e00bf3U, 0xd5a79147U, 0x06ca6351U, 0x14292967U,
    0x27b70a85U, 0x2e1b2138U, 0x4d2c6dfcU, 0x53380d13U,
    0x650a7354U, 0x766a0abbU, 0x81c2c92eU, 0x92722c85U,
    0xa2bfe8a1U, 0xa81a664bU, 0xc24b8b70U, 0xc76c51a3U,
    0xd192e819U, 0xd6990624U, 0xf40e3585U, 0x106aa070U,
    0x19a4c116U, 0x1e376c08U, 0x2748774cU, 0x34b0bcb5U,
    0x391c0cb3U, 0x4ed8aa4aU, 0x5b9cca4fU, 0x682e6ff3U,
    0x748f82eeU, 0x78a5636fU, 0x84c87814U, 0x8cc70208U,
    0x90befffaU, 0xa4506cebU, 0xbef9a3f7U, 0xc67178f2U,
};

static inline uint32_t rotr32(uint32_t x, int b) {
    return (x >> b) | (x << (32 - b));
}

static void sha256_schedule(uint32_t w[64], const uint8_t block[64]) {
    for (int i = 0; i < 16; i++) w[i] = load_be32(block + (size_t)i * 4);
    for (int i = 16; i < 64; i++) {
        uint32_t s0 = rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >> 3);
        uint32_t s1 = rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >> 10);
        w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
}

static void sha256_compress_scalar(uint32_t state[8], const uint8_t block[64]) {
    uint32_t w[64];
    sha256_schedule(w, block);

    uint32_t a = state[0];
    uint32_t b = state[1];
    uint32_t c = state[2];
    uint32_t d = state[3];
    uint32_t e = state[4];
    uint32_t f = state[5];
    uint32_t g = state[6];
    uint32_t h = state[7];

    for (int i = 0; i < 64; i++) {
        uint32_t s1 = rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
        uint32_t ch = (e & f) ^ (~e & g);
        uint32_t t1 = h + s1 + ch + sha256_k[i] + w[i];
        uint32_t s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
        uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
        uint32_t t2 = s0 + maj;
        h = g;
        g = f;
        f = e;
        e = d + t1;
        d = c;
        c = b;
        b = a;
        a = t1 + t2;
    }

    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
}

static void sha256_finish_64(void (*compress)(uint32_t state[8], const uint8_t block[64]),
                             const uint8_t *data, uint8_t digest[32]) {
    uint32_t state[8];
    memcpy(state, sha256_initial, sizeof(state));
    compress(state, data);

    uint8_t pad[64] = {0};
    pad[0] = 0x80;
    pad[62] = 0x02;
    pad[63] = 0x00;
    compress(state, pad);

    for (int i = 0; i < 8; i++) store_be32(digest + (size_t)i * 4, state[i]);
}

static void sha256_scalar_digest_64(const uint8_t *data, uint8_t digest[32]) {
    sha256_finish_64(sha256_compress_scalar, data, digest);
}

__attribute__((target("sha,sse4.1,ssse3")))
static void sha256_compress_ni(uint32_t state[8], const uint8_t block[64]) {
    __m128i tmp = _mm_loadu_si128((const __m128i *)(const void *)(state + 0));
    __m128i state1 = _mm_loadu_si128((const __m128i *)(const void *)(state + 4));
    tmp = _mm_shuffle_epi32(tmp, 0xb1);
    state1 = _mm_shuffle_epi32(state1, 0x1b);
    __m128i state0 = _mm_alignr_epi8(tmp, state1, 8);
    state1 = _mm_blend_epi16(state1, tmp, 0xf0);

    __m128i state0_save = state0;
    __m128i state1_save = state1;

    const __m128i mask = _mm_set_epi64x(0x0c0d0e0f08090a0bULL, 0x0405060700010203ULL);
    __m128i msg0 = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(const void *)(block + 0)), mask);
    __m128i msg1 = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(const void *)(block + 16)), mask);
    __m128i msg2 = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(const void *)(block + 32)), mask);
    __m128i msg3 = _mm_shuffle_epi8(_mm_loadu_si128((const __m128i *)(const void *)(block + 48)), mask);

#define K4(i) _mm_set_epi32((int)sha256_k[(i) + 3], (int)sha256_k[(i) + 2], (int)sha256_k[(i) + 1], (int)sha256_k[(i)])
#define ROUNDS4(i, msg) do { \
    __m128i msg_k = _mm_add_epi32((msg), K4(i)); \
    state1 = _mm_sha256rnds2_epu32(state1, state0, msg_k); \
    msg_k = _mm_shuffle_epi32(msg_k, 0x0e); \
    state0 = _mm_sha256rnds2_epu32(state0, state1, msg_k); \
} while (0)

    ROUNDS4(0, msg0);
    ROUNDS4(4, msg1);
    msg0 = _mm_sha256msg1_epu32(msg0, msg1);
    ROUNDS4(8, msg2);
    msg1 = _mm_sha256msg1_epu32(msg1, msg2);
    ROUNDS4(12, msg3);

    msg0 = _mm_add_epi32(msg0, _mm_alignr_epi8(msg3, msg2, 4));
    msg0 = _mm_sha256msg2_epu32(msg0, msg3);
    msg2 = _mm_sha256msg1_epu32(msg2, msg3);

    ROUNDS4(16, msg0);
    msg1 = _mm_add_epi32(msg1, _mm_alignr_epi8(msg0, msg3, 4));
    msg1 = _mm_sha256msg2_epu32(msg1, msg0);
    msg3 = _mm_sha256msg1_epu32(msg3, msg0);

    ROUNDS4(20, msg1);
    msg2 = _mm_add_epi32(msg2, _mm_alignr_epi8(msg1, msg0, 4));
    msg2 = _mm_sha256msg2_epu32(msg2, msg1);
    msg0 = _mm_sha256msg1_epu32(msg0, msg1);

    ROUNDS4(24, msg2);
    msg3 = _mm_add_epi32(msg3, _mm_alignr_epi8(msg2, msg1, 4));
    msg3 = _mm_sha256msg2_epu32(msg3, msg2);
    msg1 = _mm_sha256msg1_epu32(msg1, msg2);

    ROUNDS4(28, msg3);
    msg0 = _mm_add_epi32(msg0, _mm_alignr_epi8(msg3, msg2, 4));
    msg0 = _mm_sha256msg2_epu32(msg0, msg3);
    msg2 = _mm_sha256msg1_epu32(msg2, msg3);

    ROUNDS4(32, msg0);
    msg1 = _mm_add_epi32(msg1, _mm_alignr_epi8(msg0, msg3, 4));
    msg1 = _mm_sha256msg2_epu32(msg1, msg0);
    msg3 = _mm_sha256msg1_epu32(msg3, msg0);

    ROUNDS4(36, msg1);
    msg2 = _mm_add_epi32(msg2, _mm_alignr_epi8(msg1, msg0, 4));
    msg2 = _mm_sha256msg2_epu32(msg2, msg1);
    msg0 = _mm_sha256msg1_epu32(msg0, msg1);

    ROUNDS4(40, msg2);
    msg3 = _mm_add_epi32(msg3, _mm_alignr_epi8(msg2, msg1, 4));
    msg3 = _mm_sha256msg2_epu32(msg3, msg2);
    msg1 = _mm_sha256msg1_epu32(msg1, msg2);

    ROUNDS4(44, msg3);
    msg0 = _mm_add_epi32(msg0, _mm_alignr_epi8(msg3, msg2, 4));
    msg0 = _mm_sha256msg2_epu32(msg0, msg3);
    msg2 = _mm_sha256msg1_epu32(msg2, msg3);

    ROUNDS4(48, msg0);
    msg1 = _mm_add_epi32(msg1, _mm_alignr_epi8(msg0, msg3, 4));
    msg1 = _mm_sha256msg2_epu32(msg1, msg0);
    msg3 = _mm_sha256msg1_epu32(msg3, msg0);

    ROUNDS4(52, msg1);
    msg2 = _mm_add_epi32(msg2, _mm_alignr_epi8(msg1, msg0, 4));
    msg2 = _mm_sha256msg2_epu32(msg2, msg1);

    ROUNDS4(56, msg2);
    msg3 = _mm_add_epi32(msg3, _mm_alignr_epi8(msg2, msg1, 4));
    msg3 = _mm_sha256msg2_epu32(msg3, msg2);

    ROUNDS4(60, msg3);

#undef ROUNDS4
#undef K4

    state0 = _mm_add_epi32(state0, state0_save);
    state1 = _mm_add_epi32(state1, state1_save);

    tmp = _mm_shuffle_epi32(state0, 0x1b);
    state1 = _mm_shuffle_epi32(state1, 0xb1);
    state0 = _mm_blend_epi16(tmp, state1, 0xf0);
    state1 = _mm_alignr_epi8(state1, tmp, 8);
    _mm_storeu_si128((__m128i *)(void *)(state + 0), state0);
    _mm_storeu_si128((__m128i *)(void *)(state + 4), state1);
}

__attribute__((target("sha,sse4.1,ssse3")))
static void sha256_ni_digest_64(const uint8_t *data, uint8_t digest[32]) {
    sha256_finish_64(sha256_compress_ni, data, digest);
}

__attribute__((noinline))
static uint64_t sha256_scalar_low64(const uint8_t *data) {
    uint8_t digest[32];
    sha256_scalar_digest_64(data, digest);
    return load_be64(digest + 24);
}

__attribute__((noinline, target("sha,sse4.1,ssse3")))
static uint64_t sha256_ni_low64(const uint8_t *data) {
    uint8_t digest[32];
    sha256_ni_digest_64(data, digest);
    return load_be64(digest + 24);
}

static uint64_t sha256_scalar_run(void *arg) {
    hash_ctx_t *ctx = (hash_ctx_t *)arg;
    return sha256_scalar_low64(ctx->input);
}

static uint64_t sha256_ni_run(void *arg) {
    hash_ctx_t *ctx = (hash_ctx_t *)arg;
    return sha256_ni_low64(ctx->input);
}

int main(int argc, char **argv) {
    bench_opts_t opts = parse_opts(argc, argv);

    __builtin_cpu_init();
    if (!__builtin_cpu_supports("sse4.2")) {
        fprintf(stderr, "error: CPU does not support SSE4.2 CRC32\n");
        return 1;
    }

    hash_ctx_t ctx = {0};
    for (uint32_t i = 0; i < HASH_BYTES; i++) ctx.input[i] = (uint8_t)i;

    uint64_t crc_hw = crc32c_hw64(ctx.input);
    uint64_t crc_ref = crc32c_scalar(ctx.input, HASH_BYTES);
    if (crc_hw != crc_ref || crc_hw != 0xf8a5dd8cULL) {
        fprintf(stderr, "error: crc32 checksum validation failed\n");
        return 1;
    }
    if (siphash13_64(ctx.input) != 0xf17997ec4b4a6065ULL) {
        fprintf(stderr, "error: siphash checksum validation failed\n");
        return 1;
    }
    if (sha256_scalar_low64(ctx.input) != 0x8c447cd1d9151108ULL) {
        fprintf(stderr, "error: sha256 scalar checksum validation failed\n");
        return 1;
    }

    bool use_sha_ni = __builtin_cpu_supports("sha");
    bench_fn sha256_fn = sha256_scalar_run;
    if (use_sha_ni) {
        if (sha256_ni_low64(ctx.input) != sha256_scalar_low64(ctx.input)) {
            fprintf(stderr, "error: sha256 SHA-NI checksum validation failed\n");
            return 1;
        }
        sha256_fn = sha256_ni_run;
        fprintf(stderr, "hash / sha256: implementation=sha-ni\n");
    } else {
        fprintf(stderr, "hash / sha256: implementation=scalar\n");
    }

    result_t results[3];
    int ri = 0;
    results[ri++] = measure("hash", "crc32", 1, HASH_BYTES, crc32_run, &ctx, opts.samples, opts.target_calibration_ns);
    results[ri++] = measure("hash", "siphash", 1, HASH_BYTES, siphash_run, &ctx, opts.samples, opts.target_calibration_ns);
    results[ri++] = measure("hash", "sha256", 1, HASH_BYTES, sha256_fn, &ctx, opts.samples, opts.target_calibration_ns);
    print_json(results, ri);
    return 0;
}

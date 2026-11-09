# Second provider check: Cloudflare R2

Date: 2026-11-09

## Scope

This note checks, on paper, whether an S3-shaped object-store measurement design works on Cloudflare R2 when measured from a VM in AWS or Google Cloud. The design covers:

- a Target named by region and storage class;
- one bucket per measurement series;
- a fixture object proved with `HeadObject` (length, storage class, full-object CRC32C);
- scoped short-lived credentials;
- a probe PUT before each run;
- a listing after each run;
- a hand-written HTTP/1.1 + TLS + SigV4 client.

## Source policy

Primary sources only: developers.cloudflare.com (R2 docs, API reference, release notes) and blog.cloudflare.com. Docs were fetched as raw Markdown (`<page>/index.md`), and API reference pages with `Accept: text/markdown`, so quotes are verbatim page text, not tool summaries. Table rows are quoted cell by cell, joined with ` | `. The one blog post was taken from HTML with the tags stripped. NOT FOUND means the fact was not found in a primary source. Where sources disagree, both are quoted.

## Answers at a glance

1. **Where a bucket lives.** A bucket gets one of six region hints (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`). Hints are "best effort and not a guarantee", and only the first creation of a bucket name counts. Jurisdictions (`eu`, `fedramp`, `us`, plus `fedramp-high` in the API enum) are guaranteed and can never be changed. The S3 API always reports the region as `auto`; only the Cloudflare REST bucket object has a `location` field. Nothing finer than the six hint regions is documented. https://developers.cloudflare.com/r2/reference/data-location/
2. **Storage classes.** There are two: Standard and Infrequent Access. The S3 API calls them `STANDARD` / `STANDARD_IA`; the Cloudflare API calls them `Standard` / `InfrequentAccess`. Class is set per object, and a bucket can have a default class. Infrequent Access has a 30-day minimum and a $0.01/GB retrieval fee. The docs do not say whether `HeadObject` returns `x-amz-storage-class` (NOT FOUND); listing examples do show `StorageClass`. https://developers.cloudflare.com/r2/buckets/storage-classes/
3. **Endpoint names.** The S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, or `https://<ACCOUNT_ID>.<JURISDICTION>.r2.cloudflarestorage.com` for a jurisdiction. Both path-style and virtual-hosted style work, and the SigV4 region is `auto` (empty and `us-east-1` are aliases). `r2.dev` is rate-limited and meant for testing only. Custom domains go through Cloudflare's cache; the S3 API "do[es] not transit through the cache". TLS/HTTP versions on the S3 endpoint are NOT FOUND, and HTTP `100 Continue` is not supported. https://developers.cloudflare.com/r2/api/s3/api/
4. **S3 API compatibility.** The core object and multipart operations are implemented. Versioning and SSE-KMS are not. SSE-C is supported. CRC32C is supported only as a `COMPOSITE` checksum; `FULL_OBJECT` is available only for `CRC64NVME`. Limits are 5 GiB per single PUT (4.995 GiB in the footnote), parts of 5 MiB to 5 GiB that must all be the same size except the last, 10,000 parts, and 4.995 TiB per object. Multipart ETags are `md5(concat part md5s)-N`. https://developers.cloudflare.com/r2/api/s3/api/
5. **Credentials.** For long-lived keys, the S3 Access Key ID is the token `id` and the secret is the SHA-256 of the token `value`. `POST /accounts/{id}/r2/temp-access-credentials` takes `bucket`, `parentAccessKeyId`, `permission` (four presets), `ttlSeconds` (max 604800 = 7 days), `prefixes` and `objects`, and returns a session token that is sent as `X-Amz-Security-Token`. A credential has one permission across all its paths. No API reads back a credential's scope (NOT FOUND). https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
6. **Lifecycle and deletion.** S3-style lifecycle rules support prefix filters, expiry by `Days` or `Date`, `AbortIncompleteMultipartUpload`, and transition to `STANDARD_IA` (one-way). Objects are deleted "typically ... within 24 hours" of expiry. Every bucket has a default rule that aborts incomplete multipart uploads after 7 days. https://developers.cloudflare.com/r2/buckets/object-lifecycles/
7. **Hidden machinery.** Every request enters an edge "R2 Gateway" near the client. Reads may be served from a "Tiered Read Cache" and a cached metadata layer that the customer cannot see. Local Uploads (opt-in) writes near the client and replicates asynchronously. Consistency is strong, including for listing. There is a 1 write/s per key limit, `r2.dev` is throttled at "hundreds of requests/second", and 5xx overloads "can trigger bucket-wide read and write locks". https://developers.cloudflare.com/r2/how-r2-works/
8. **Account limits.** The default is 100,000 buckets per account (but a 2024 release note says 1 million). Bucket management is limited to 50 operations/s per bucket, and the REST API to 1,200 requests per 5 minutes. Keys are up to 1,024 bytes and are NFC-normalized. https://developers.cloudflare.com/r2/platform/limits/
9. **Cost of measuring.** Egress is free. Standard costs $0.015/GB-month, $4.50 per million Class A operations and $0.36 per million Class B operations. Infrequent Access costs $0.01/GB-month, $9.00 / $0.90 per million operations, and $0.01/GB retrieval. The free tier (10 GB-month, 1M Class A, 10M Class B) covers Standard only. Requests that fail authentication are not billed. https://developers.cloudflare.com/r2/pricing/

## 1. Where a bucket lives

- Quote: "When you create a new bucket, the data location is set to Automatic by default. Currently, this option chooses a bucket location in the closest available region to the create bucket request based on the location of the caller."
- URL: https://developers.cloudflare.com/r2/reference/data-location/
- Gloss: With no hint, the bucket lands near whoever calls create, which is the controller.

- Quote: "Keep in mind Location Hints are a best effort and not a guarantee"
- URL: https://developers.cloudflare.com/r2/reference/data-location/
- Gloss: A hint is not a contract.

- Quote: "wnam | Western North America", "enam | Eastern North America", "weur | Western Europe", "eeur | Eastern Europe", "apac | Asia-Pacific", "oc | Oceania"
- URL: https://developers.cloudflare.com/r2/reference/data-location/
- Gloss: These six values are the whole vocabulary; the S3 example passes `LocationConstraint: "WNAM"`.

- Quote: "Location Hints are only honored the first time a bucket with a given name is created. If you delete and recreate a bucket with the same name, the original bucket's location will be used."
- URL: https://developers.cloudflare.com/r2/reference/data-location/
- Gloss: A bucket name keeps its first location for good.

- Quote: "Jurisdictional Restrictions guarantee objects in a bucket are stored within a specific jurisdiction." … "eu | European Union", "fedramp | FedRAMP", "us | United States" … "Once an R2 bucket is created, the jurisdiction cannot be changed."
- URL: https://developers.cloudflare.com/r2/reference/data-location/
- Gloss: Jurisdictions are the only guaranteed placement, and they are fixed at creation.

- Quote: "jurisdiction: optional \"default\"or \"eu\"or \"us\"or 2 more — Jurisdiction where objects in this bucket are guaranteed to be stored." … "\"fedramp-high\"" … "location: optional \"apac\"or \"eeur\"or \"enam\"or 3 more — Location of the bucket." … "storage\_class: optional \"Standard\"or \"InfrequentAccess\""
- URL: https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/get/
- Gloss: The REST bucket object has `creation_date`, `jurisdiction`, `location`, `name` and `storage_class`. It also lists a `fedramp-high` jurisdiction that the data-location page omits.

- Quote: "Implemented `GetBucketLocation` for compatibility with external tools, this will always return a `LocationConstraint` of `auto`." / "`HeadBucket` now sets `x-amz-bucket-region` to `auto` in the response."
- URL: https://developers.cloudflare.com/r2/platform/release-notes/
- Gloss: The S3 API never reveals where the bucket is.

- Quote: "The **Object Read & Write** and **Object Read only** permissions are only supported by the S3-compatible API, not the Cloudflare REST API."
- URL: https://developers.cloudflare.com/r2/api/tokens/
- Gloss: Reading `location` needs an Admin-level token.

- Whether the reported `location` can differ from the hint, or change after creation: NOT FOUND ("best effort" implies the first can happen).
- A finer place name than the region (city, data center): NOT FOUND. The durability page says only "hardware distributed across several data centers within a geographic region".

## 2. Storage classes

- Quote: "Standard | None | None | None" / "Infrequent Access | 30 days | Yes | None" (columns: Minimum storage duration | Data retrieval fees | Egress fees)
- URL: https://developers.cloudflare.com/r2/buckets/storage-classes/
- Gloss: There are two classes.

- Quote: "Every object stored in R2 has an associated storage class." … "Default storage class can be changed after bucket creation in the Dashboard."
- URL: https://developers.cloudflare.com/r2/buckets/storage-classes/
- Gloss: Class is per object, and the bucket default can change underneath you.

- Quote: "Use the `x-amz-storage-class` header to change between `STANDARD` and `STANDARD_IA`."
- URL: https://developers.cloudflare.com/r2/buckets/storage-classes/
- Gloss: These are the S3 strings. The Cloudflare API uses "storageClass: optional \"Standard\"or \"InfrequentAccess\"" (https://developers.cloudflare.com/api/resources/r2/subresources/buckets/methods/create/).

- Quote: "✅ Storage Class: ✅ x-amz-storage-class ✅ STANDARD ✅ STANDARD\_IA"
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: Listed for PutObject, CreateMultipartUpload and CopyObject; the HeadObject row says nothing about storage class.

- Quote: "Once an object is stored in Infrequent Access, it cannot be transitioned to Standard Access using lifecycle policies."
- URL: https://developers.cloudflare.com/r2/buckets/storage-classes/
- Gloss: Lifecycle moves are one-way; going back needs CopyObject.

- Quote: "\"StorageClass\": \"STANDARD\""
- URL: https://developers.cloudflare.com/r2/examples/aws/aws-cli/
- Gloss: The ListObjectsV2 example output includes the class.

- Whether `HeadObject`/`GetObject` return `x-amz-storage-class` (for either class): NOT FOUND.

## 3. Endpoint names

- Quote: "The API is available via the `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` endpoint."
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: This is the default endpoint.

- Quote: "`https://<ACCOUNT_ID>.<JURISDICTION>.r2.cloudflarestorage.com` … When using a jurisdiction endpoint, you will not be able to access R2 resources outside of that jurisdiction."
- URL: https://developers.cloudflare.com/r2/reference/data-location/
- Gloss: Jurisdiction buckets have their own hostname. Location hints do not.

- Quote: "Add support for S3 virtual-hosted style paths, such as `<BUCKET>.<ACCOUNT_ID>.r2.cloudflarestorage.com` instead of path-based routing ( `<ACCOUNT_ID>.r2.cloudflarestorage.com/<BUCKET>`)."
- URL: https://developers.cloudflare.com/r2/platform/release-notes/
- Gloss: Both styles work, and the docs use both.

- Quote: "When using the S3 API, the region for an R2 bucket is `auto`. For compatibility with tools that do not allow you to specify a region, an empty value and `us-east-1` will alias to the `auto` region."
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: The SigV4 credential scope is `<date>/auto/s3/aws4_request`.

- Quote: "If you exceed the rate limit (hundreds of requests/second), requests to your `r2.dev` endpoint will be temporarily throttled" … "Bandwidth (throughput) may also be throttled when using the `r2.dev` endpoint."
- URL: https://developers.cloudflare.com/r2/platform/limits/
- Gloss: `r2.dev` is unfit for measurement.

- Quote: "The cache does not affect access via Worker API bindings or the S3 API, as these operations are made directly against the bucket and do not transit through the cache."
- URL: https://developers.cloudflare.com/r2/reference/consistency/
- Gloss: Custom domains go through the Cloudflare CDN cache; the S3 endpoint does not. Section 7 covers R2's own internal read cache, which is separate.

- Quote: "Data transfer between a client and R2 is secured using the same Transport Layer Security (TLS/SSL) supported on all Cloudflare domains."
- URL: https://developers.cloudflare.com/r2/reference/data-security/
- Gloss: This is the only TLS statement that covers R2 in general.

- Quote: "However, Cloudflare does not support the HTTP `100` response."
- URL: https://developers.cloudflare.com/r2/api/s3/extensions/
- Gloss: A client must not send `Expect: 100-continue` and wait for a reply.

- TLS and HTTP versions on `*.r2.cloudflarestorage.com`: NOT FOUND. HTTP/2 is documented only for custom domains.

## 4. S3 API compatibility, operation by operation

- Quote: "✅ HeadBucket | ❌ Bucket Owner: ❌ x-amz-expected-bucket-owner"; "✅ GetBucketLocation"; "✅ PutBucketLifecycleConfiguration"
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: All three are implemented (without the expected-owner header).

- Quote: "✅ HeadObject | ✅ Conditional Operations … ✅ Range (has no effect in HeadObject) ✅ partNumber ✅ SSE-C"
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: Only request features are listed; there is no list of response headers.

- Quote: "✅ ListObjectsV2 | Query Parameters: ✅ list-type ✅ continuation-token ✅ delimiter ✅ encoding-type ✅ fetch-owner ✅ max-keys ✅ prefix ✅ start-after"
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: Listing with a delimiter works. Note also that "Unsupported search parameters to `ListObjects`/ `ListObjectsV2` are now rejected with `501 Not Implemented`" (release notes).

- Quote: "❌ PutBucketVersioning"; "❌ GetBucketVersioning"
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: There is no versioning.
- Contradiction: the release notes say "Added dummy implementations … `GetBucketVersioning`" (https://developers.cloudflare.com/r2/platform/release-notes/).

- Quote: "❌ SSE: ❌ x-amz-server-side-encryption-aws-kms-key-id ❌ x-amz-server-side-encryption …" / "✅ SSE-C: ✅ x-amz-server-side-encryption-customer-algorithm …"
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: The SSE request header is marked not implemented; SSE-C works. Encryption at rest is always on, per the data-security page: "Encryption and decryption are automatic, do not require user configuration to enable". Whether `x-amz-server-side-encryption` appears in responses: NOT FOUND.
- Contradiction: the compatibility page marks `PutBucketEncryption` unimplemented, but the release notes say "`GetBucketEncryption`, `PutBucketEncryption` and `DeleteBucketEncrypotion` are now supported (the only supported value currently is `AES256`)".

- Quote: "CRC-64/NVME (`CRC64NVME`) | ✅ | ❌" / "CRC-32 (`CRC32`) | ❌ | ✅" / "CRC-32C (`CRC32C`) | ❌ | ✅" / "SHA-1 (`SHA1`) | ❌ | ✅" / "SHA-256 (`SHA256`) | ❌ | ✅" (columns: `FULL_OBJECT` | `COMPOSITE`)
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: Only CRC64NVME has the full-object type. CRC32C is composite only.

- Quote: "The CRC-64/NVME Checksum algorithm is now supported for both single and multipart objects. This also brings support for the `FULL_OBJECT` Checksum Type on Multipart Uploads."
- URL: https://developers.cloudflare.com/r2/platform/release-notes/
- Gloss: For multipart uploads, a full-object checksum means CRC64NVME (added 2025-07-03).

- Quote: "…X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject"
- URL: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Gloss: An example URL carries checksum-mode. This is the only mention of it.
- NOT FOUND: whether HeadObject returns `x-amz-checksum-crc32c` or `x-amz-checksum-type`, and what "COMPOSITE" means for a single-part PUT.

- Quote: "Maximum upload size | 5 GiB (single-part) / 4.995 TiB (multi-part)"; "Maximum upload parts | 10,000"; "The object size limit is 5 GiB less than 5 TiB, so 4.995 TiB."; "The max upload size is 5 MiB less than 5 GiB, so 4.995 GiB."
- URL: https://developers.cloudflare.com/r2/platform/limits/
- Gloss: "5 GiB" per request or part really means 4.995 GiB.

- Quote: "Minimum part size: 5 MiB (except for the last part)" / "Maximum part size: 5 GiB" / "All parts except the last must be the same size"
- URL: https://developers.cloudflare.com/r2/objects/upload-objects/
- Gloss: Unlike S3, parts must be the same size.

- Quote: "The ETag of the completed multipart object is the hash of the concatenated binary MD5 sums of all parts, followed by a hyphen and the number of parts."
- URL: https://developers.cloudflare.com/r2/objects/upload-objects/
- Gloss: This is the same convention as S3.

- Quote: "Uploading to the same part number replaces the previous part. If a subsequent upload to the same part fails, the original part is lost and must be re-uploaded."
- URL: https://developers.cloudflare.com/r2/api/s3/api/
- Gloss: A failed retry of a part destroys the earlier copy.

## 5. Credentials

- Quote: "Access Key ID: The `id` of the API token." / "Secret Access Key: The SHA-256 hash of the API token `value`."
- URL: https://developers.cloudflare.com/r2/api/tokens/
- Gloss: This is how S3 keys are derived from an API token.

- Quote: "bucket: string" … "parentAccessKeyId: string" … "permission: \"admin-read-write\"or \"admin-read-only\"or \"object-read-write\"or \"object-read-only\"" … "ttlSeconds: number — Lifetime of the temporary credentials in seconds, up to 604800 seconds (7 days)." … "objects: optional array of string" … "prefixes: optional array of string"
- URL: https://developers.cloudflare.com/api/resources/r2/subresources/temporary_credentials/methods/create/
- Gloss: These are the request fields, with a 7-day maximum TTL. The response contains `accessKeyId`, `secretAccessKey` and `sessionToken`.

- Quote: "`prefixes` / `prefixPaths`: keys starting with any listed prefix." / "`objects` / `objectPaths`: exact object keys."
- URL: https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
- Gloss: Scope can be an exact key, a prefix, or both.

- Quote: "Every temporary credential is bound to a single bucket and a set of permitted operations. You can optionally restrict the credential further to specific paths within the bucket."
- URL: https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
- Gloss: One permission covers every path, so "read K, write under P" becomes read-write on both.

- Quote: "`actions` is currently supported via local signing only. Support in the Temporary Credentials API is coming soon."
- URL: https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
- Gloss: Per-operation lists (`GetObject`, `PutObject`, …) require minting the JWT yourself.

- Quote: "The session token is sent with every request via the `X-Amz-Security-Token` header"
- URL: https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
- Gloss: There is a session token, as with STS.

- Quote: "Encode the session token as `base64(\"jwt/\" + <signed-jwt>)`. … The parent access key ID is reused as the temporary access key ID."
- URL: https://developers.cloudflare.com/r2/api/s3/temporary-credentials/
- Gloss: For locally signed credentials the scope sits inside the token. The docs do not say whether API-minted tokens use the same format.

- Quote: "IAM: Adding/removing R2 Storage permissions | Eventually consistent: A new or updated API key may take up to a minute to have permissions reflected globally"
- URL: https://developers.cloudflare.com/r2/reference/consistency/
- Gloss: A new parent token can take a minute to work; temporary credentials are not mentioned.

- An API that reads back a credential's scope: NOT FOUND.

## 6. Lifecycle and deletion

- Quote: "When you create an object lifecycle rule, you can specify which prefix you would like it to apply to." / "Note that object lifecycles currently has a 1000 rule maximum."
- URL: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- Gloss: Rules can be scoped by prefix.

- Quote: "Expiration: { Days: 90, }," / "AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7, }," / "Transitions: [ { Days: 30, StorageClass: \"STANDARD_IA\", }, ],"
- URL: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- Gloss: The documented PutBucketLifecycleConfiguration example uses whole days. No finer granularity is documented.

- Quote: "Objects will typically be removed from a bucket within 24 hours of the `x-amz-expiration` value."
- URL: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- Gloss: Expiry can be up to about a day late.

- Quote: "Buckets have a default lifecycle rule to expire multipart uploads seven days after initiation."
- URL: https://developers.cloudflare.com/r2/buckets/object-lifecycles/
- Gloss: This is on by default.

## 7. Things between the request and the bytes that the customer cannot see

- Quote: "**R2 Gateway:** The entry point for all API requests that handles authentication and routing logic. This service is deployed across Cloudflare's global network via Cloudflare Workers."
- URL: https://developers.cloudflare.com/r2/how-r2-works/
- Gloss: A VM connects to the nearest Cloudflare edge, which forwards the request to the bucket's region.

- Quote: "**Metadata Service:** … It includes a built-in cache layer to speed up access to metadata." / "**Tiered Read Cache:** A caching layer that sits in front of the Distributed Storage Infrastructure that speeds up object reads by using Cloudflare Tiered Cache to serve data closer to the client."
- URL: https://developers.cloudflare.com/r2/how-r2-works/
- Gloss: There are two caches the customer cannot see.

- Quote: "The Gateway attempts to retrieve the encrypted object from the tiered read cache. If it's not available, it retrieves the object from one of the distributed storage data centers within the region that holds the object data."
- URL: https://developers.cloudflare.com/r2/how-r2-works/
- Gloss: GET latency depends on cache state.

- Quote: "Out of the box, it automatically caches object data globally for fast reads anywhere — all while retaining strong consistency and zero egress fees. This happens behind the scenes whether you're using the S3 API, Workers Bindings, or plain HTTP."
- URL: https://blog.cloudflare.com/r2-local-uploads/ (2026-02-03)
- Gloss: The blog explicitly includes the S3 API. Compare section 3's "do not transit through the cache", which appears to mean the CDN cache.

- Quote: "Local Uploads writes object data to a nearby location, then asynchronously copies it to your bucket. Data is available immediately and remains strongly consistent." / "Reads from the uploader's region will be fast, while reads from near the bucket's region may experience cross-region latency until replication completes."
- URL: https://developers.cloudflare.com/r2/buckets/local-uploads/
- Gloss: Local Uploads is opt-in per bucket and unavailable for jurisdiction buckets.

- Quote: "we saw up to 75% reduction in Time to Last Byte (TTLB) when upload requests are made in a different region than the bucket"
- URL: https://blog.cloudflare.com/r2-local-uploads/
- Gloss: One toggle makes a large difference to PUT latency.

- Quote: "Read-after-write: … Strongly consistent: readers will immediately see the latest object globally" / "Object listing: … Strongly consistent: the list operation will list all objects at that point in time"
- URL: https://developers.cloudflare.com/r2/reference/consistency/
- Gloss: Reads and listings are strongly consistent.

- Quote: "Maximum concurrent writes to the same object name (key) | 1 per second"
- URL: https://developers.cloudflare.com/r2/platform/limits/
- Gloss: Faster writes to one key get 429.

- Quote: "These errors can trigger bucket-wide read and write locks, affecting the performance of all ongoing operations."
- URL: https://developers.cloudflare.com/r2/platform/troubleshooting/
- Gloss: This is about 5xx overload. No per-bucket request-rate figure is published.

## 8. Account limits

- Quote: "Maximum number of buckets per account | Unlimited, with a default limit of 100,000. Each bucket above 100,000 costs $0.10 per month."
- URL: https://developers.cloudflare.com/r2/platform/limits/
- Gloss: This is the current limits page.
- Contradiction: the release notes (2024-11-20) say "The default maximum number of buckets per account is now 1 million."

- Quote: "Maximum rate of bucket management operations per bucket | 50 per second"
- URL: https://developers.cloudflare.com/r2/platform/limits/
- Gloss: Object reads and writes are excluded.

- Quote: "The Cloudflare REST API is rate limited to 1,200 requests per five minutes across all R2 REST API operations on your account."
- URL: https://developers.cloudflare.com/r2/platform/limits/
- Gloss: This limits the controller's management calls, temp-credential minting included.

- Quote: "Object key length | 1,024 bytes"; "Object metadata size | 8,192 bytes"
- URL: https://developers.cloudflare.com/r2/platform/limits/
- Gloss: These are the key constraints.

- Quote: "we have chosen to NFC-normalize key names before storing by default."
- URL: https://developers.cloudflare.com/r2/reference/unicode-interoperability/
- Gloss: Use ASCII keys.

- Quote: "Bucket names can only contain lowercase letters (a-z), numbers (0-9), and hyphens (-)." / "Bucket names can only be between 3-63 characters in length."
- URL: https://developers.cloudflare.com/r2/buckets/create-buckets/
- Gloss: Bucket names cannot contain dots.

## 9. Cost of measuring

- Quote: "Storage | $0.015 / GB-month | $0.01 / GB-month"; "Class A Operations | $4.50 / million requests | $9.00 / million requests"; "Class B Operations | $0.36 / million requests | $0.90 / million requests"; "Data Retrieval (processing) | None | $0.01 / GB" (columns: Standard | Infrequent Access)
- URL: https://developers.cloudflare.com/r2/pricing/
- Gloss: These are the headline prices.

- Quote: "Egressing directly from R2, including via the Workers API, S3 API, and `r2.dev` domains does not incur data transfer (egress) charges and is free."
- URL: https://developers.cloudflare.com/r2/pricing/
- Gloss: Downloads to a VM in AWS or GCP are free on R2's side.

- Quote: "Storage | 10 GB-month / month"; "Class A Operations | 1 million requests / month"; "Class B Operations | 10 million requests / month"; "The free tier only applies to Standard storage, and does not apply to Infrequent Access storage."
- URL: https://developers.cloudflare.com/r2/pricing/
- Gloss: This is the free tier.

- Quote: "Class A Operations include `ListBuckets`, `PutBucket`, `ListObjects`, `PutObject`, …" / "Class B Operations include `HeadBucket`, `HeadObject`, `GetObject`, …" / "Free operations include `DeleteObject`, `DeleteBucket` and `AbortMultipartUpload`."
- URL: https://developers.cloudflare.com/r2/pricing/
- Gloss: The post-run listing is billed as Class A.

- Quote: "Requests that fail during authentication or authorization are not charged."
- URL: https://developers.cloudflare.com/r2/pricing/
- Gloss: A rejected probe is free, but a 412 or `BadDigest` failure is billed.

## Surprises for an S3-shaped design

1. **The S3 API will not say where a bucket is.** `GetBucketLocation` returns `auto` and `HeadBucket` sets `x-amz-bucket-region: auto`. Only `location` on the REST Get Bucket response reports it, and that needs an Admin token.
2. **Placement is a hint, not a region.** It is "best effort and not a guarantee". Without a hint, the bucket lands near the caller (the controller), not the VM. Only jurisdictions are guaranteed, and they are coarse.
3. **Bucket names remember their first location.** If a bucket is re-created under the same name, the original location is used and the new hint is ignored. One bucket per series is safe only if names are never reused.
4. **There is no full-object CRC32C.** CRC32C is `COMPOSITE` only, and `FULL_OBJECT` exists only for `CRC64NVME`. The docs do not say whether HeadObject returns `x-amz-checksum-*` or `x-amz-storage-class`, so the fixture proof cannot be confirmed on paper. Switch to CRC64NVME or test empirically.
5. **Storage class strings differ by API.** S3 uses `STANDARD`/`STANDARD_IA`; the Cloudflare API uses `Standard`/`InfrequentAccess`. The bucket's default class can be changed later.
6. **"Read one key, write under one prefix" cannot be expressed through the API.** A temporary credential has one `permission` across all its paths, so the fixture key becomes writable too. Per-operation `actions` exist only for locally signed JWTs, and no API reads back a credential's scope.
7. **Probe PUTs share a per-key limit.** The limit is 1 write/s per key (429 above that), so use a fresh probe key each time.
8. **Hidden caches sit on the read path.** An edge gateway near the client, a metadata cache, and a Tiered Read Cache that a Cloudflare blog says applies to the S3 API too. Cold and warm reads can differ for reasons the customer cannot see. The docs never reconcile this with "S3 API … do not transit through the cache".
9. **One toggle changes write latency.** Local Uploads, a per-bucket setting, cuts cross-region PUT TTLB by up to 75%. It must be recorded as part of the Target, or kept off and checked.
10. **The client is a Cloudflare edge, not a region.** Requests from an AWS or GCP VM go to the nearest Cloudflare edge before reaching the bucket's region.
11. **No `100 Continue`.** TLS and HTTP versions on the S3 endpoint are undocumented.
12. **Multipart rules are stricter than S3.** Parts must be equal size except the last. A failed re-upload of a part loses the earlier copy. The real limit is 4.995 GiB per part or PUT, not 5 GiB.
13. **Listing is billed as Class A**, and unknown list query parameters return `501`.
14. **Overload is shared across a bucket.** 5xx overloads "can trigger bucket-wide read and write locks", and no per-bucket rate figure is published.
15. **Keys are NFC-normalized and bucket names cannot contain dots.**
16. **Downloads are free.** GET throughput tests cost only Class B operations ($0.36 per million).

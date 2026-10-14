# Amazon S3 facts for the LedgerMath design discussion — verified against AWS docs

Researched 2026-10-09. Sources are limited to `docs.aws.amazon.com` and `aws.amazon.com`. Every quote below is verbatim from the page at the cited URL as rendered by the fetch tool. AWS's own markup for user-supplied placeholders renders as `{{like-this}}` (e.g. `{{bucket-name}}`); that is the doc's placeholder, not mine. Where a fact could not be confirmed, the entry says **NOT FOUND IN DOCS**.

Legend: **CONFIRMED** = matches the premise in the question. **CORRECTED** = the docs say something different from the premise. **NOT FOUND IN DOCS** = no official statement located.

---

## 0. Headline findings (things that differ from common belief)

1. **Maximum object size is no longer 5 TB.** The multipart-limits page says `Maximum object size | 48.8 TiB`, the General Reference quota table says `Object size | Each Account: 48.828125 Terabytes`, and the upload page says "up to 50 TB in size". The single-PUT limit is still 5 GB; part size is still 5 MiB–5 GiB; parts still 10,000. (Section 3.)
2. **Five new checksum algorithms exist** beyond CRC32/CRC32C/CRC64NVME/SHA1/SHA256: `MD5`, `XXHASH64`, `XXHASH3`, `XXHASH128`, `SHA512`, with headers `x-amz-checksum-md5`, `x-amz-checksum-xxhash64`, `x-amz-checksum-xxhash3`, `x-amz-checksum-xxhash128`, `x-amz-checksum-sha512`. All five are composite-only for multipart. (Section 2.)
3. **The `StorageClass` enum has 15 values**, three more than the list in the question: `FSX_ONTAP`, `AWS_BACKUP_WARM`, `AWS_BACKUP_LOW_COST_WARM`. (Section 4.)
4. **Directory buckets accept `ONEZONE_IA` in Dedicated Local Zones** (and `EXPRESS_ONEZONE` in Availability Zones); the API reference repeats this sentence on PutObject/GetObject/HeadObject. (Section 4.)
5. **`x-amz-object-size` is only a PutObject response header, only for appends to EXPRESS_ONEZONE objects.** It is not in the GetObject or HeadObject response syntax. (Section 2.)
6. **`GetBucketLocation` is officially "no longer a best practice"**; AWS tells you to use `HeadBucket`, and `GetBucketLocation` "is not supported for directory buckets". `us-east-1` → `null`; `EU` → `eu-west-1`. (Section 1.)
7. **`ListDirectoryBuckets` does not return `BucketRegion`** even though the `Bucket` data type has that field. (Section 1.)
8. **HTTP/2 on S3 API endpoints: NOT FOUND IN DOCS.** No S3 doc mentions HTTP/2; every request-syntax example is `HTTP/1.1`; the only AWS HTTP/2 doc is the Java SDK event-streaming (Kinesis) page. TLS: "Amazon S3 supports TLS 1.2 and TLS 1.3"; "Clients must support Transport Layer Security (TLS) 1.2"; TLS 1.3 is **not** available on PrivateLink interface endpoints. (Section 5.)
9. **Nothing in an S3 response reveals the network path.** `x-amz-id-2` / `x-amz-request-id` are documented purely as support-troubleshooting tokens. The documented server-side signal is CloudTrail's `vpcEndpointId` field (and `tlsDetails`). (Section 6.)
10. **Per-SDK default checksum algorithm differs:** AWS CLI v2 and the C++ SDK default to `CRC64NVME`; Java 2.x, Go v2, JS v3, Kotlin, .NET, PHP, Python (Boto3), Ruby, Rust, Swift, PowerShell default to `CRC32`. S3 itself falls back to `CRC64NVME` when nothing is supplied. (Section 2.)

---

## 1. Observing a bucket's Region and location

### 1.1 `HeadBucket` response headers — CONFIRMED (names exact)

URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html

Response syntax, verbatim:

```
HTTP/1.1 200
x-amz-bucket-arn: {{BucketArn}}
x-amz-bucket-location-type: {{BucketLocationType}}
x-amz-bucket-location-name: {{BucketLocationName}}
x-amz-bucket-region: {{BucketRegion}}
x-amz-access-point-alias: {{AccessPointAlias}}
```

Per-header wording:

- `x-amz-bucket-region` — "The Region that the bucket is located. Length Constraints: Minimum length of 0. Maximum length of 20."
- `x-amz-access-point-alias` — "Indicates whether the bucket name used in the request is an access point alias. For directory buckets, the value of this field is `false`."
- `x-amz-bucket-location-type` — "The type of location where the bucket is created. This functionality is only supported by directory buckets. Valid Values: `AvailabilityZone | LocalZone`"
- `x-amz-bucket-location-name` — "The name of the location where the bucket will be created. For directory buckets, the Zone ID of the Availability Zone or the Local Zone where the bucket is created. An example Zone ID value for an Availability Zone is `usw2-az1`. This functionality is only supported by directory buckets."
- `x-amz-bucket-arn` — "The Amazon Resource Name (ARN) of the S3 bucket. ... This parameter is only supported for S3 directory buckets. ... Pattern: `arn:[^:]+:(s3|s3express):.*`"

So for a general purpose bucket only `x-amz-bucket-region` and `x-amz-access-point-alias` are documented as present; the sample response shows exactly those two:

```
HTTP/1.1 200 OK
x-amz-id-2: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
x-amz-request-id: 28PG2CEB32F5EE25
x-amz-bucket-region: us-west-2
x-amz-access-point-alias: false
Date: Fri, 10 2012 21:34:56 GMT
Server: AmazonS3
```

Region is returned even on error. Doc text: "You can make a `HeadBucket` call on any bucket name to any Region in the partition, and regardless of the permissions on the bucket, you will receive a response header with the correct bucket location so that you can then make a proper, signed request to the appropriate Regional endpoint." The sample `301 Moved Permanantly` and `403 Forbidden` responses both carry `x-amz-bucket-region: us-east-1`. Note: "If the bucket doesn't exist or you don't have permission to access it, the `HEAD` request returns a generic `400 Bad Request`, `403 Forbidden`, or `404 Not Found` HTTP status code. A message body isn't included".

Directory buckets: "The HTTP Host header syntax is ` Bucket-name.s3express-zone-id.region-code.amazonaws.com`." and "Path-style requests are not supported." Auth: "**Directory buckets** - You must use IAM credentials to authenticate and authorize your access to the `HeadBucket` API operation, instead of using the temporary security credentials through the `CreateSession` API operation."

### 1.2 `GetBucketLocation` — CONFIRMED (null for us-east-1, legacy `EU`)

URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketLocation.html

- "**Important** Using the `GetBucketLocation` operation is no longer a best practice. To return the Region that a bucket resides in, we recommend that you use the HeadBucket operation instead. For backward compatibility, Amazon S3 continues to support the `GetBucketLocation` operation."
- "In a bucket's home Region, calls to the `GetBucketLocation` operation are governed by the bucket's policy. In other Regions, the bucket policy doesn't apply, which means that cross-account access won't be authorized. However, calls to the `HeadBucket` operation always return the bucket's location through an HTTP response header, whether access to the bucket is authorized or not."
- "**Note** This operation is not supported for directory buckets."
- `LocationConstraint` element: "Specifies the Region where the bucket resides. ... Buckets in Region `us-east-1` have a LocationConstraint of `null`. Buckets with a LocationConstraint of `EU` reside in `eu-west-1`."
- Valid Values (verbatim): `af-south-1 | ap-east-1 | ap-east-2 | ap-northeast-1 | ap-northeast-2 | ap-northeast-3 | ap-south-1 | ap-south-2 | ap-southeast-1 | ap-southeast-2 | ap-southeast-3 | ap-southeast-4 | ap-southeast-5 | ap-southeast-6 | ap-southeast-7 | ca-central-1 | ca-west-1 | cn-north-1 | cn-northwest-1 | EU | eu-central-1 | eu-central-2 | eu-north-1 | eu-south-1 | eu-south-2 | eu-west-1 | eu-west-2 | eu-west-3 | il-central-1 | me-central-1 | me-south-1 | mx-central-1 | sa-east-1 | us-east-2 | us-gov-east-1 | us-gov-west-1 | us-west-1 | us-west-2`
- Note `us-east-1` is **not** in the Valid Values list (it is represented by null/empty). The sample response is a single element: `<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">us-west-2</LocationConstraint>`

### 1.3 `ListDirectoryBuckets` — CONFIRMED with one surprise

URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListDirectoryBuckets.html

- Endpoint: "you must make requests for this API operation to the Regional endpoint. These endpoints support path-style requests in the format `https://s3express-control.region-code.amazonaws.com/bucket-name `. Virtual-hosted-style requests aren't supported." Host header: "`s3express-control.region.amazonaws.com`".
- Permission: "You must have the `s3express:ListAllMyDirectoryBuckets` permission in an IAM identity-based policy instead of a bucket policy."
- Response syntax:

```
<ListAllMyDirectoryBucketsResult>
   <Buckets>
      <Bucket>
         <BucketArn>string</BucketArn>
         <BucketRegion>string</BucketRegion>
         <CreationDate>timestamp</CreationDate>
         <Name>string</Name>
      </Bucket>
   </Buckets>
   <ContinuationToken>string</ContinuationToken>
</ListAllMyDirectoryBucketsResult>
```

- **Surprise:** "**Note** The `BucketRegion` response element is not part of the `ListDirectoryBuckets` Response Syntax." (So do not rely on it; use `HeadBucket` → `x-amz-bucket-region`, or parse the zone-id out of the bucket name.)
- `Bucket` data type (https://docs.aws.amazon.com/AmazonS3/latest/API/API_Bucket.html): "`BucketRegion` indicates the AWS region where the bucket is located. If the request contains at least one valid parameter, it is included in the response." `CreationDate`: "Date the bucket was created. This date can change when making changes to your bucket, such as editing its bucket policy."

### 1.4 `CreateBucket` for directory buckets — CONFIRMED

URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html

Request body syntax (verbatim):

```
<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
   <LocationConstraint>{{string}}</LocationConstraint>
   <Location>
      <Name>{{string}}</Name>
      <Type>{{string}}</Type>
   </Location>
   <Bucket>
      <DataRedundancy>{{string}}</DataRedundancy>
      <Type>{{string}}</Type>
   </Bucket>
   <Tags>...</Tags>
</CreateBucketConfiguration>
```

- `Bucket` — "Specifies the information about the bucket that will be created. This functionality is only supported by directory buckets. Type: BucketInfo"
- `BucketInfo.Type` (https://docs.aws.amazon.com/AmazonS3/latest/API/API_BucketInfo.html): "The type of bucket. Type: String Valid Values: `Directory`"
- `BucketInfo.DataRedundancy`: "The number of Zone (Availability Zone or Local Zone) that's used for redundancy for the bucket. Type: String Valid Values: `SingleAvailabilityZone | SingleLocalZone`"
- `LocationInfo.Type` (https://docs.aws.amazon.com/AmazonS3/latest/API/API_LocationInfo.html): "The type of location where the bucket will be created. Type: String Valid Values: `AvailabilityZone | LocalZone`"
- `LocationInfo.Name`: "For directory buckets, the name of the location is the Zone ID of the Availability Zone (AZ) or Local Zone (LZ) where the bucket will be created. An example AZ ID value is `usw2-az1`."
- `LocationConstraint`: "If you don't specify a Region, the bucket is created in the US East (N. Virginia) Region (us-east-1) by default. Configurations using the value `EU` will create a bucket in `eu-west-1`. ... This functionality is not supported for directory buckets."
- `Location`: "**Directory buckets** - The location type is Availability Zone or Local Zone. To use the Local Zone location type, your account must be enabled for Local Zones. Otherwise, you get an HTTP `403 Forbidden` error with the error code `AccessDenied`."
- Host: "**Directory buckets** - The HTTP Host header syntax is `s3express-control.region-code.amazonaws.com`." Path-style only.
- Response: `Location` header and `x-amz-bucket-arn` ("This parameter is only supported for S3 directory buckets.").
- `Location` header for general purpose buckets: "A forward slash followed by the name of the bucket for all account regional namespace buckets and all global general purpose buckets created in us-east-1. For example, `/amzn-s3-demo-bucket`. For global general purpose buckets created in other AWS Regions, the Location field is the global endpoint URL. For example, `http://amzn-s3-demo-bucket.s3.amazonaws.com/`."

### 1.5 Directory bucket naming suffix — CONFIRMED

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-naming-rules.html

- Format: "`{{base-name}}--{{zoneid}}--x-s3`" ; example "`{{bucket-base-name}}--usw2-az1--x-s3`".
- "Name must be between 3 (min) and 63 (max) characters long, including the suffix."
- "Must include the following suffix: `--{{zone-id}}--x-s3`."
- "Be unique within the chosen Zone (AWS Availability Zone or AWS Local Zone)."
- "Consists only of lowercase letters, numbers and hyphens (-)." "Begin and end with a letter or number."
- "When you create a directory bucket by using an API, you must provide the full suffix, including the Zone ID, in your request."
- CreateBucket page restates: "Bucket names must also follow the format ` bucket-base-name--zone-id--x-s3` (for example, ` DOC-EXAMPLE-BUCKET--usw2-az1--x-s3`)".
- General purpose bucket rules (https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html): "Bucket names must not end with the suffix `--x-s3`. This suffix is reserved for directory buckets."
- Note: the differences page (https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html) contains a typo, "followed by `--x-s`" — treat the naming-rules page as authoritative.

---

## 2. Observing an object

### 2.1 `HeadObject` / `GetObject` response headers

URLs: https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html , https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html

HeadObject response-syntax header list (verbatim subset, order as in doc): `x-amz-delete-marker`, `accept-ranges`, `x-amz-expiration`, `x-amz-restore`, `x-amz-archive-status`, `Last-Modified`, `Content-Length`, `x-amz-checksum-crc32`, `x-amz-checksum-crc32c`, `x-amz-checksum-crc64nvme`, `x-amz-checksum-sha1`, `x-amz-checksum-sha256`, `x-amz-checksum-sha512`, `x-amz-checksum-md5`, `x-amz-checksum-xxhash64`, `x-amz-checksum-xxhash3`, `x-amz-checksum-xxhash128`, `x-amz-checksum-type`, `ETag`, `x-amz-missing-meta`, `x-amz-version-id`, `Cache-Control`, `Content-Disposition`, `Content-Encoding`, `Content-Language`, `Content-Type`, `Content-Range`, `Expires`, `x-amz-website-redirect-location`, `x-amz-server-side-encryption`, `x-amz-server-side-encryption-customer-algorithm`, `x-amz-server-side-encryption-customer-key-MD5`, `x-amz-server-side-encryption-aws-kms-key-id`, `x-amz-server-side-encryption-bucket-key-enabled`, `x-amz-storage-class`, `x-amz-request-charged`, `x-amz-replication-status`, `x-amz-mp-parts-count`, `x-amz-tagging-count`, `x-amz-object-lock-*`.

- **`x-amz-storage-class` — CONFIRMED absent for STANDARD.** HeadObject and GetObject use identical wording: "Provides storage class information of the object. Amazon S3 returns this header for all objects except for S3 Standard storage class objects." Followed by: "**Directory buckets** - Directory buckets only support `EXPRESS_ONEZONE` (the S3 Express One Zone storage class) in Availability Zones and `ONEZONE_IA` (the S3 One Zone-Infrequent Access storage class) in Dedicated Local Zones." Valid Values: `STANDARD | REDUCED_REDUNDANCY | STANDARD_IA | ONEZONE_IA | INTELLIGENT_TIERING | GLACIER | DEEP_ARCHIVE | OUTPOSTS | GLACIER_IR | SNOW | EXPRESS_ONEZONE | FSX_OPENZFS | FSX_ONTAP | AWS_BACKUP_WARM | AWS_BACKUP_LOW_COST_WARM`
- `Content-Length` — "Size of the body in bytes." (both pages). HeadObject `Range`: "If the Range is satisfiable, only the `ContentLength` is affected in the response."
- `Last-Modified` — "Date and time when the object was last modified." GetObject adds: "**General purpose buckets** - When you specify a `versionId` of the object in your request, if the specified version in the request is a delete marker, the response returns a `405 Method Not Allowed` error and the `Last-Modified: timestamp` response header."
- `ETag` — HeadObject/GetObject only say: "An entity tag (ETag) is an opaque identifier assigned by a web server to a specific version of a resource found at a URL." The MD5 rules are documented elsewhere (2.2 below).
- `x-amz-version-id` — "Version ID of the object. This functionality is not supported for directory buckets."
- `x-amz-checksum-crc32` (HeadObject) — "The Base64 encoded, 32-bit `CRC32 checksum` of the object. This checksum is only present if the checksum was uploaded with the object. When you use an API operation on an object that was uploaded using multipart uploads, this value may not be a direct checksum value of the full object. Instead, it's a calculation based on the checksum values of each individual part." (`x-amz-checksum-crc32c`, `x-amz-checksum-sha1`, `x-amz-checksum-sha256` use the same sentence with "32-bit `CRC32C` checksum", "160-bit `SHA1` digest", "256-bit `SHA256` digest".)
- `x-amz-checksum-crc64nvme` — "The Base64 encoded, 64-bit `CRC64NVME` checksum of the object." (No "only present if uploaded" clause.)
- `x-amz-checksum-md5` — "The Base64 encoded, 128-bit `MD5` digest of the object." `x-amz-checksum-sha512` — "The Base64 encoded, 512-bit `SHA512` digest of the object." `x-amz-checksum-xxhash64` — "The Base64 encoded, 64-bit `XXHASH64` checksum of the object." `x-amz-checksum-xxhash3` — "The Base64 encoded, 64-bit `XXHASH3` checksum of the object." `x-amz-checksum-xxhash128` — "The Base64 encoded, 128-bit `XXHASH128` checksum of the object."
- `x-amz-checksum-type` — "The checksum type, which determines how part-level checksums are combined to create an object-level checksum for multipart objects. You can use this header response to verify that the checksum type that is received is the same checksum type that was specified in `CreateMultipartUpload` request. ... Valid Values: `COMPOSITE | FULL_OBJECT`"
- `x-amz-mp-parts-count` — "The count of parts this object has. This value is only returned if you specify `partNumber` in your request and the object was uploaded as a multipart upload."
- `x-amz-archive-status` — "The archive state of the head object. This functionality is not supported for directory buckets. Valid Values: `ARCHIVE_ACCESS | DEEP_ARCHIVE_ACCESS`"
- `x-amz-restore` — "If the object is an archived object (an object whose storage class is GLACIER), the response includes this header if either the archive restoration is in progress ... or an archive copy is already restored. ... `x-amz-restore: ongoing-request="false", expiry-date="Fri, 21 Dec 2012 00:00:00 GMT"`"
- **`x-amz-object-size` — CORRECTED.** It does not appear in the HeadObject or GetObject response syntax at all. It is a **PutObject response** header only (https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html): "The size of the object in bytes. This value is only be present if you append to an object. This functionality is only supported for objects in the Amazon S3 Express One Zone storage class in directory buckets." Related PutObject request header `x-amz-write-offset-bytes`: "Specifies the offset for appending data to existing objects in bytes. The offset must be equal to the size of the existing object being appended to. If no object exists, setting this header to 0 will create a new object. This functionality is only supported for objects in the Amazon S3 Express One Zone storage class in directory buckets."
- **`x-amz-checksum-mode` request header — CONFIRMED.** HeadObject: "To retrieve the checksum, this parameter must be enabled. ... Valid Values: `ENABLED`". GetObject: "To retrieve the checksum, this mode must be enabled. Valid Values: `ENABLED`". KMS caveat (HeadObject): "If you enable `x-amz-checksum-mode` in the request and the object is encrypted with AWS Key Management Service (AWS KMS), you must also have the `kms:GenerateDataKey` and `kms:Decrypt` permissions".
- Archived objects on GetObject: "If the object you are retrieving is stored in the S3 Glacier Flexible Retrieval storage class, the S3 Glacier Deep Archive storage class, the S3 Intelligent-Tiering Archive Access tier, or the S3 Intelligent-Tiering Deep Archive Access tier, before you can retrieve the object you must first restore a copy using RestoreObject. Otherwise, this operation returns an `InvalidObjectState` error." Error table: "**InvalidObjectState** Object is archived and inaccessible until restored. ... HTTP Status Code: 403". Sample body: `<Code>InvalidObjectState</Code><Message>The action is not valid for the object's storage class</Message>`; for Intelligent-Tiering: `<Message>The action is not valid for the object's access tier</Message><StorageClass>INTELLIGENT_TIERING</StorageClass><AccessTier>ARCHIVE_ACCESS</AccessTier>`.
- Directory buckets on GetObject: "Unsupported storage class values won't write a destination object and will respond with the HTTP status code `400 Bad Request`." Versioning: "only the `null` value of the version ID is supported by directory buckets."

### 2.2 When ETag is / is not the MD5 — CONFIRMED (multipart, SSE-KMS, SSE-C) plus directory-bucket rule

URL: https://docs.aws.amazon.com/AmazonS3/latest/developerguide/RESTCommonResponseHeaders.html (the `/API/RESTCommonResponseHeaders.html` link currently serves a redirect shell; the developerguide path renders)

ETag row, verbatim: "The entity tag (ETag) represents a specific version of the object. The ETag reflects changes only to the contents of an object, not its metadata. The ETag might or might not be an MD5 digest of the object data. Whether or not it is depends on how the object was created and how it is encrypted, as follows:+  Objects created through the AWS Management Console or by the `PUT` Object, `POST Object`, or `Copy` operation:     Objects that are plaintext or encrypted by server-side encryption with Amazon S3 managed keys (SSE-S3) have ETags that are an MD5 digest of their data.     Objects encrypted by server-side encryption with customer-provided keys (SSE-C) or AWS Key Management Service (AWS KMS) keys (SSE-KMS) have ETags that are not an MD5 digest of their object data.    + Objects created by either the Multipart Upload or Upload Part Copy operation have ETags that are not MD5 digests, regardless of the method of encryption."

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html — same three rules, plus: "If an object is larger than 16 MB, the AWS Management Console uploads or copies that object as a multipart upload, and therefore the ETag isn't an MD5 digest." And the multipart ETag construction: "Amazon S3 calculates the MD5 digest of each individual part as it is uploaded. The MD5 digests are used to determine the ETag for the final object. Amazon S3 concatenates the bytes for the MD5 digests together and then calculates the MD5 digest of these concatenated values. During the final ETag creation step, Amazon S3 adds a dash with the total number of parts to the end."

Directory buckets: PutObject ETag response header: "**Directory buckets** - The ETag for the object in a directory bucket isn't the MD5 digest of the object." Differences page: "Entity tags (ETags) for directory buckets are random alphanumeric strings unique to the object and not MD5 checksums."

Other common headers from the same page: `x-amz-id-2` — "A special token that is used together with the `x-amz-request-id` header to help AWS troubleshoot problems. ... Type: String Default: None". `x-amz-request-id` — "A value created by Amazon S3 that uniquely identifies the request. This value is used together with the `x-amz-id-2` header to help AWS troubleshoot problems." `x-amz-version-id` — "When you `PUT` an object in a bucket where versioning has been suspended, the version ID is always `null`." `Server` — "Default: `AmazonS3`". `Connection` — "Valid Values: `open` | `close`".

### 2.3 Full-object vs composite checksums per algorithm — CONFIRMED and extended

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html

Table ("which checksum algorithm type is supported for each checksum algorithm in a multipart upload"), verbatim:

| Checksum algorithm | Full object | Composite |
| --- | --- | --- |
| CRC-64/NVME (CRC64NVME) | Yes | No |
| CRC-32 (CRC32) | Yes | Yes |
| CRC-32C (CRC32C) | Yes | Yes |
| SHA-1 (SHA1) | No | Yes |
| SHA-256 (SHA256) | No | Yes |
| MD5 (MD5) | No | Yes |
| XXHash64 (XXHASH64) | No | Yes |
| XXHash3 (XXHASH3) | No | Yes |
| XXHash128 (XXHASH128) | No | Yes |
| SHA-512 (SHA512) | No | Yes |

Prose: "For full object checksums, you can use CRC-64/NVME (`CRC64NVME`), CRC-32 (`CRC32`), or CRC-32C (`CRC32C`) checksum algorithms in S3. Full object checksums in multipart uploads are only available for CRC-based checksums because they can linearize into a full object checksum. ... This type of validation isn't available for other algorithms, such as SHA and MD5."

Single-part: "Checksums of objects that are uploaded in a single part (using `PutObject`) are treated as full object checksums." PutObject `x-amz-checksum-type` response: "For `PutObject` uploads, the checksum type is always `FULL_OBJECT`." PutObject `x-amz-checksum-crc64nvme` request header: "The `CRC64NVME` checksum is always a full object checksum."

Caution: the at-rest page (https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-at-rest.html) says "All supported checksum algorithms support both the full object and composite checksum types, except CRC-64/NVME (`CRC64NVME`), which supports the full object checksum type only." — that sentence is about the S3 Batch Operations **Compute checksum** job on data at rest, not about what you can attach on upload.

Multipart gotcha: "If you use a multipart upload with **Checksums** for composite (or part-level) checksums, the multipart upload part numbers must be consecutive and begin with 1. If you try to complete a multipart upload request with nonconsecutive part numbers, Amazon S3 generates an `HTTP 500 Internal Server` error." And for the new algorithms: "When using multipart uploads with the new checksum algorithms (MD5, XXHash3, XXHash64, XXHash128, SHA-512), you must specify the checksum algorithm in the `CreateMultipartUpload` request using the `x-amz-checksum-algorithm` header."

### 2.4 Default integrity protections (December 2024) — CONFIRMED with nuance

- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html — "**Note** The `CRC64NVME` checksum algorithm is the default checksum algorithm used for checksum calculations."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html — "If you don't specify a checksum algorithm and the SDK also doesn't calculate a checksum for you, then S3 automatically chooses the CRC-64/NVME (`CRC64NVME`) checksum algorithm." and "Because S3 has default integrity protections, if objects are uploaded without a checksum, S3 automatically attaches the recommended full object CRC-64/NVME (`CRC64NVME`) checksum algorithm to the object."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html — `x-amz-checksum-crc64nvme` response: "This header is present if the object was uploaded with the `CRC64NVME` checksum algorithm, or if it was uploaded without a checksum (and Amazon S3 added the default checksum, `CRC64NVME`, to the uploaded object)."
- URL: https://aws.amazon.com/about-aws/whats-new/2024/12/amazon-s3-default-data-integrity-protections — "Posted on: Dec 1, 2024"; "The latest AWS SDKs now automatically calculate CRC-based checksums for uploads as data is transmitted over the network."; S3 stores a "CRC-based whole-object checksum" in object metadata including for "multipart uploads"; "rolling out across all AWS Regions in the next few weeks."
- URL: https://aws.amazon.com/blogs/aws/introducing-default-data-integrity-protections-for-new-objects-in-amazon-s3/ — dated "01 DEC 2024": "The new default data integrity protections use the existing CRC32 and CRC32C algorithms or the new CRC64NVME algorithm." and for uploads lacking a CRC, "Amazon S3 computes a CRC-based checksum anyway and stores it in the object metadata for future reference."
- **Nuance — "CRC64NVME as the SDK default" is only true for some SDKs.** URL: https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html — "Now, we've enabled these checks by default, using CRC-based algorithms such as CRC32 or CRC64NVME. Although each SDK or tool has a default algorithm, you can choose a different algorithm." Default-algorithm column: AWS CLI v2 → `CRC64NVME`; SDK for C++ → `CRC64NVME`; Go V2, Java 2.x, JavaScript 3.x, Kotlin, .NET 4.x/3.x, PHP 3.x, Python (Boto3), Ruby 3.x, Rust, Swift, PowerShell V5/V4 → `CRC32`. Java 2.x and Python get CRC64NVME "Via CRT only". Settings: `request_checksum_calculation` / `AWS_REQUEST_CHECKSUM_CALCULATION`, default `WHEN_SUPPORTED` (other value `WHEN_REQUIRED`); `response_checksum_validation`, default `WHEN_SUPPORTED`. "If your application uses a version prior to December 2024 of the SDK or tool, Amazon S3 still computes a CRC64NVME checksum on new objects and stores it in the object metadata for future reference."

### 2.5 `PutObject` checksum request headers — CONFIRMED

URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html

- `x-amz-sdk-checksum-algorithm` — "Indicates the algorithm used to create the checksum for the object when you use the SDK. This header will not provide any additional functionality if you don't use the SDK. When you send this header, there must be a corresponding `x-amz-checksum-algorithm ` or `x-amz-trailer` header sent. Otherwise, Amazon S3 fails the request with the HTTP status code `400 Bad Request`." Listed algorithms begin `CRC32`, `CRC32C`, `CRC64NVME`, `MD5`, `SHA1`, `SHA256` (list continues).
- `x-amz-checksum-sha256` — "This header can be used as a data integrity check to verify that the data received is the same data that was originally sent. This header specifies the Base64 encoded, 256-bit `SHA256` digest of the object."
- `x-amz-checksum-crc64nvme` — "... Base64 encoded, 64-bit `CRC64NVME` checksum of the object. The `CRC64NVME` checksum is always a full object checksum."
- `Content-MD5` — "The Base64 encoded 128-bit `MD5` digest of the message (without the headers) according to RFC 1864. ... This functionality is not supported for directory buckets."
- User guide guidance for raw REST callers (checking-object-integrity-upload): "**When you use the REST API**, don't use the `x-amz-sdk-checksum-algorithm` parameter. Instead, use one of the algorithm-specific headers (for example, `x-amz-checksum-crc32`)."
- Trailing checksums: `x-amz-trailer` supported values "`x-amz-checksum-crc32`, `x-amz-checksum-crc32c`, `x-amz-checksum-crc64nvme`, `x-amz-checksum-sha1`, `x-amz-checksum-sha256`"; `x-amz-content-sha256` is `STREAMING-UNSIGNED-PAYLOAD-TRAILER` or `STREAMING-AWS4-HMAC-SHA256-PAYLOAD-TRAILER`; body chunks "must contain at least 8,192 bytes (or 8 KiB) of object data, except for the final body chunk".

Directory-bucket checksum support: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance.html — "You can select one of the following Secure Hash Algorithms (SHA) or Cyclic Redundancy Check (CRC) data-integrity check algorithms: CRC32, CRC32C, SHA-1, and SHA-256. MD5-based checksums are not supported with the S3 Express One Zone storage class." and "CRC32 is the default checksum used by the AWS SDKs when transmitting data to or from directory buckets. We recommend using CRC32 and CRC32C for the best performance with directory buckets." (This page does not list CRC64NVME; the differences page lists "MD5 checksums" under features not supported by directory buckets.)

---

## 3. Limits

### 3.1 Object / PUT / multipart limits — CORRECTED (object max), CONFIRMED (rest)

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html — table, verbatim:

| Item | Specification |
| --- | --- |
| Maximum object size | 48.8 TiB |
| Maximum number of parts per upload | 10,000 |
| Part numbers | 1 to 10,000 (inclusive) |
| Part size | 5 MiB to 5 GiB. There is no minimum size limit on the last part of your multipart upload. |
| Maximum number of parts returned for a list parts request | 1000 |
| Maximum number of multipart uploads returned in a list multipart uploads request | 1000 |

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html — "With a single `PUT` operation, you can upload a single object up to 5 GB in size." ; "With the Amazon S3 console, you can upload a single object up to 160 GB in size." ; "Using the multipart upload API operation, you can upload a single large object, up to 50 TB in size." ; "You can use a multipart upload for objects from 5 MB to 50 TB in size." ; "To upload files greater than 5 TB, use the S3 Transfer Manager in the Java v1/v2, Python, or AWS CLI SDKs."

URL: https://docs.aws.amazon.com/general/latest/gr/s3.html — quota rows: "Object size | Each Account: 48.828125 Terabytes | No | The maximum size (in TB) of an Amazon S3 object" ; "Maximum part size | Each Account: 5 Gigabytes" ; "Minimum part size | Each Account: 5 Megabytes ... The last part uploaded can be less than the stated minimum" ; "Parts | Each Account: 10,000" ; "Object size (Console upload) | Each Account: 160 Gigabytes" ; "General purpose buckets | Each Account: 10,000 | Yes" ; "Directory buckets | Each Account: 100 | Yes".

Multipart overview (https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html): "You can choose any part number between 1 and 10,000." "It's a best practice to use multipart upload for objects that are 100 MB or larger".

### 3.2 Directory bucket differences — NOT FOUND IN DOCS for a different size limit

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html — states no different size/part-count limits; its code samples repeat "Minimum 5 MiB, Maximum 5 GiB. There is no minimum size for the last part of your multipart upload." The documented differences are behavioral: "the multipart part numbers must be consecutive part numbers. If you try to complete a multipart upload request with nonconsecutive part numbers, an `HTTP 400 Bad Request` (Invalid Part Order) error is generated." and "This ETag is not an MD5 hash of the object data." Differences page: "The object creation date is the completion date of the multipart upload." and "Appending data to existing objects isn't supported for directory buckets that reside in Local Zones."

### 3.3 Bucket name length — CONFIRMED (3–63)

- General purpose (https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html): "Bucket names must be between 3 (min) and 63 (max) characters long." Legacy: "Before March 1, 2018, buckets created in the US East (N. Virginia) Region could have names that were up to 255 characters long and included uppercase letters and underscores." Also: "Buckets used with Amazon S3 Transfer Acceleration can't have periods (`.`) in their names." Account-regional namespace format: "`{{bucket-name-prefix}}-accountId-region-an`".
- Directory: "Name must be between 3 (min) and 63 (max) characters long, including the suffix."

### 3.4 Per-prefix request rate — CONFIRMED

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html — "your application can achieve at least 3,500 PUT/COPY/POST/DELETE or 5,500 GET/HEAD requests per second per partitioned Amazon S3 prefix. There are no limits to the number of prefixes in a bucket. ... if you create 10 prefixes in an Amazon S3 bucket to parallelize reads, you could scale your read performance to 55,000 read requests per second. ... The scaling, in the case of both read and write operations, happens gradually and is not instantaneous ... While Amazon S3 is scaling to your new higher request rate, you may see some 503 (Slow Down) errors." Latency: "consistent small object latencies (and first-byte-out latencies for larger objects) of roughly 100–200 milliseconds." Throughput: "up to 100 Gb/s on a single instance".

---

## 4. Storage classes

### 4.1 `StorageClass` values accepted by `PutObject` — CORRECTED (15 values)

URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html — `x-amz-storage-class`: "By default, Amazon S3 uses the STANDARD Storage Class to store newly created objects. ... + Directory buckets only support `EXPRESS_ONEZONE` (the S3 Express One Zone storage class) in Availability Zones and `ONEZONE_IA` (the S3 One Zone-Infrequent Access storage class) in Dedicated Local Zones. + Amazon S3 on Outposts only uses the OUTPOSTS Storage Class. Valid Values: `STANDARD | REDUCED_REDUNDANCY | STANDARD_IA | ONEZONE_IA | INTELLIGENT_TIERING | GLACIER | DEEP_ARCHIVE | OUTPOSTS | GLACIER_IR | SNOW | EXPRESS_ONEZONE | FSX_OPENZFS | FSX_ONTAP | AWS_BACKUP_WARM | AWS_BACKUP_LOW_COST_WARM`"

Values beyond the question's list: `FSX_ONTAP`, `AWS_BACKUP_WARM`, `AWS_BACKUP_LOW_COST_WARM`. (HeadObject/GetObject `x-amz-storage-class` carry the identical list.)

### 4.2 Which classes GET without restore — CONFIRMED

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html and https://docs.aws.amazon.com/AmazonS3/latest/userguide/glacier-storage-classes.html

- GLACIER_IR: "**S3 Glacier Instant Retrieval** (`GLACIER_IR`) – Use for long-term data that's rarely accessed and requires milliseconds retrieval. Data in this storage class is available for real-time access." Glacier page table: "S3 Glacier Instant Retrieval | 90 days | Quarterly | Milliseconds | No" (Archival? = No). "S3 Glacier Instant Retrieval storage class offers real-time access to your objects with the same latency and throughput performance as the S3 Standard-IA storage class."
- GLACIER: "Data in this storage class is archived, and not available for real-time access." Retrieval tiers: "**Expedited retrieval** – Typically restores the object in 1–5 minutes." "**Standard retrieval** – Typically restores the object in 3–5 hours" "**Bulk retrieval** – Typically restores the object within 5–12 hours. Bulk retrievals are free."
- DEEP_ARCHIVE: "archived, and not available for real-time access." "**Standard retrieval** – Typically restores the object within 12 hours" "**Bulk retrieval** – Typically restores the object within 48 hours".
- Both: "To access these objects, you first initiate a restore request which creates a temporary copy of the object". GetObject returns `InvalidObjectState` (403) otherwise (see 2.1).
- INTELLIGENT_TIERING: three automatic tiers "Frequent Access", "Infrequent Access" (after "30 consecutive days"), "Archive Instant Access" (after "90 consecutive days") — "The Archive Instant Access tier delivers millisecond access and high-throughput performance." Two optional tiers: "Archive Access" (90+ days) and "Deep Archive Access" (180+ days) — "If the object that you are retrieving is stored in the Archive Access or Deep Archive Access tiers, first restore the object by using `RestoreObject`." "If the size of an object is less than 128 KB, it is not monitored and not eligible for auto-tiering." HeadObject exposes the tier via `x-amz-archive-status: ARCHIVE_ACCESS | DEEP_ARCHIVE_ACCESS`.
- STANDARD_IA / ONEZONE_IA: "S3 Standard-IA and S3 One Zone-IA objects are available for millisecond access (similar to the S3 Standard storage class). Amazon S3 charges a retrieval fee for these objects".
- REDUCED_REDUNDANCY: "**Important** We recommend not using this storage class." "If an RRS object is lost, when requests are made to that object, Amazon S3 returns a 405 error."
- OUTPOSTS: "The S3 Outposts storage class is available only for objects stored in buckets on Outposts. If you try to use this storage class with an S3 bucket in an AWS Region, an `InvalidStorageClass` error occurs."

### 4.3 Minimum duration / minimum billable size — CONFIRMED

Comparison table (storage-class-intro), columns "Min storage duration | Min billable object size":

- `STANDARD`: None | None
- `STANDARD_IA`: 30 days | 128 KB ("Per-GB retrieval fees apply.")
- `INTELLIGENT_TIERING`: None | None ("Objects less than 128KB are not monitored and always stored in the Frequent Access tier.")
- `ONEZONE_IA`: 30 days | 128 KB
- `EXPRESS_ONEZONE`: None | None (availability "99.95%", "1" AZ)
- `GLACIER_IR`: 90 days | 128 KB
- `GLACIER`: 90 days | NA* — "* S3 Glacier Flexible Retrieval requires 40 KB of additional metadata for each archived object. This includes 32 KB of metadata charged at the S3 Glacier Flexible Retrieval rate ... and an additional 8 KB data charged at the S3 Standard rate."
- `DEEP_ARCHIVE`: 180 days | NA** (same 40 KB note)
- `REDUCED_REDUNDANCY`: None | None

Prose: "If an object is less than 128 KB, Amazon S3 charges you for 128 KB. If you delete an object before the end of the 30-day minimum storage duration period, you are charged for 30 days." Glacier page: "There is a minimum object size of 128 KB for data stored in the S3 Glacier Instant Retrieval storage class. This storage class also has a minimum storage duration period of 90 days."

### 4.4 Directory bucket storage classes — CONFIRMED (EXPRESS_ONEZONE in AZs; ONEZONE_IA in Dedicated Local Zones)

- API reference (PutObject/GetObject/HeadObject, quoted above): "Directory buckets only support `EXPRESS_ONEZONE` ... in Availability Zones and `ONEZONE_IA` ... in Dedicated Local Zones."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-data-residency.html — "Directory buckets in Dedicated Local Zones can support the S3 Express One Zone and S3 One Zone-Infrequent Access (S3 One Zone-IA; Z-IA) storage classes." and "Directory buckets in Local Zones support the S3 One Zone-Infrequent Access (S3 One Zone-IA; Z-IA) storage class." (So the user guide allows EXPRESS_ONEZONE in *Dedicated* Local Zones too; the API pages say ONEZONE_IA for Dedicated Local Zones. Minor inconsistency between the two doc sets.)
- storage-class-intro: "For data residency and isolation use cases, you can create directory buckets in AWS Local Zones and use the S3 Express One Zone (`EXPRESS_ONEZONE`) and S3 One Zone-IA (`ONEZONE_IA`) storage classes."

### 4.5 Is `x-amz-storage-class` returned for EXPRESS_ONEZONE on GET/HEAD? — NOT FOUND IN DOCS (explicitly)

The only rule is the general one: "Amazon S3 returns this header for all objects except for S3 Standard storage class objects." By that rule an `EXPRESS_ONEZONE` object would carry the header, and the directory-bucket note sits directly under that header's description, but no sentence says "directory buckets return `x-amz-storage-class: EXPRESS_ONEZONE`". Treat as expected-but-unverified; confirm empirically.

---

## 5. Endpoints and URLs

### 5.1 Hostname formats — CONFIRMED

Virtual-hosted / path-style (https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html):
- "`https://{{bucket-name}}.s3.{{region-code}}.amazonaws.com/{{key-name}}`"
- "`https://s3.{{region-code}}.amazonaws.com/{{bucket-name}}/{{key-name}}`"
- Host header rule: "If the `Host` header is omitted or its value is `s3.{{region-code}}.amazonaws.com`, the bucket for the request will be the first slash-delimited component of the Request-URI ... Otherwise, if the value of the `Host` header ends in `.s3.{{region-code}}.amazonaws.com`, the bucket name is the leading component of the `Host` header's value".
- SSL caveat: "the SSL wildcard certificate matches only buckets that do not contain dots (`.`)".

Dual-stack (https://docs.aws.amazon.com/AmazonS3/latest/developerguide/dual-stack-endpoints.html — the `/userguide/` path currently serves a redirect shell): "Virtual hosted-style dual-stack endpoint: {{bucketname}}.s3.dualstack.{{aws-region}}.amazonaws.com" ; "Path-style dual-stack endpoint: s3.dualstack.{{aws-region}}.amazonaws.com/{{bucketname}}" ; "Amazon S3 supports only regional dual-stack endpoint names, which means that you must specify the region as part of the name." ; "The two types of Virtual Private Cloud (VPC) endpoints that access Amazon S3 (*Interface VPC endpoints* and *Gateway VPC endpoints*) now have dual-stack support."

FIPS (https://docs.aws.amazon.com/general/latest/gr/s3.html), us-east-1 row: "s3.us-east-1.amazonaws.com / s3.dualstack.us-east-1.amazonaws.com / s3-fips.us-east-1.amazonaws.com / s3-fips.dualstack.us-east-1.amazonaws.com" with protocols "HTTP and HTTPS / HTTP and HTTPS / HTTPS / HTTPS". FIPS rows exist only for us-east-1, us-east-2, us-west-1, us-west-2, ca-central-1, ca-west-1, us-gov-east-1, us-gov-west-1. Interface-endpoint FIPS service name: "`com.amazonaws.{{region}}.s3-fips`".

Legacy global endpoint (VirtualHosting): "`{{bucket-name}}.s3.amazonaws.com`" ; "Requests made with the legacy global endpoint go to the US East (N. Virginia) Region by default." ; "If you create a bucket in a Region that was launched before March 20, 2019, and use the legacy global endpoint, Amazon S3 updates the DNS record to reroute the request ... In the meantime ... Amazon S3 then redirects it with an HTTP 307 Temporary Redirect to the correct Region." ; "For S3 buckets in Regions launched after March 20, 2019, the DNS server doesn't route your request directly ... It returns an HTTP 400 Bad Request error instead." ; path-style via global endpoint: "For the US East (N. Virginia) Region, you can use the legacy global endpoint for path-style requests. For all other Regions ... you receive an HTTP response code 301 Permanent Redirect". Also legacy dash form "`https://{{bucket-name}}.s3-{{region-code}}.amazonaws.com`". CreateBucket page: "If you send your `CreateBucket` request to the `s3.amazonaws.com` global endpoint, the request goes to the `us-east-1` Region."

Transfer Acceleration (https://docs.aws.amazon.com/AmazonS3/latest/userguide/transfer-acceleration.html): "you must use the endpoint `{{bucket-name}}.s3-accelerate.amazonaws.com`. Or, use the dual-stack endpoint `{{bucket-name}}.s3-accelerate.dualstack.amazonaws.com`" ; "Transfer Acceleration is only supported on virtual-hosted style requests." ; "must be DNS-compliant and must not contain periods" ; it "takes advantage of the globally distributed edge locations in Amazon CloudFront" ; not supported for directory buckets (differences page lists "S3 Transfer Acceleration" as unsupported).

Directory bucket endpoints (https://docs.aws.amazon.com/AmazonS3/latest/userguide/endpoint-directory-buckets-AZ.html): Regional `s3express-control.us-east-1.amazonaws.com` / `s3express-control.dualstack.us-east-1.amazonaws.com`; Zonal `s3express-use1-az4.us-east-1.amazonaws.com` / `s3express-use1-az4.dualstack.us-east-1.amazonaws.com` (us-east-1 zone IDs listed: `use1-az4`, `use1-az5`, `use1-az6`; us-west-2: `usw2-az1`, `usw2-az3`, `usw2-az4`). "Bucket-level (or control plane) API operations are available through Regional endpoints ... Examples of Regional endpoint API operations are `CreateBucket` and `DeleteBucket`." "Object-level (or data plane) API operations are available through Zonal endpoints ... Examples of Zonal endpoint API operations are `CreateSession` and `PutObject`." Virtual-hosted form from the API pages: "`https://bucket-name.s3express-zone-id.region-code.amazonaws.com/key-name `" with "Path-style requests are not supported." Local Zones (https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-lzs-for-directory-buckets.html): "Regional endpoints are in the format of `s3express-control.ParentRegionCode.amazonaws.com`." "Zonal endpoints are in the format of `s3express-LocalZoneID.ParentRegionCode.amazonaws.com`." "All object-level API operations (such as `PutObject`) and two bucket-level API operations (`CreateSession` and `HeadBucket`) are routed to Zonal endpoints". Gateway endpoint service for directory buckets: "**com.amazonaws.**{{region}}**.s3express**" (vpc-endpoints-s3 page); note on gateway-endpoints page: "For directory buckets, or S3 Express One Zone, the gateway endpoints for the data plane would be `s3express-use2-az1.us-east-2.amazonaws.com` and `s3express-use2-az1.dualstack.us-east-2.amazonaws.com` respectively."

Interface (PrivateLink) endpoints (https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html):
- "A *Regional* DNS name includes a unique VPC endpoint ID, a service identifier, the AWS Region, and `vpce.amazonaws.com` in its name. For example, for VPC endpoint ID `{{vpce-1a2b3c4d}}`, the DNS name generated might be similar to `{{vpce-1a2b3c4d-5e6f}}.s3.us-east-1.vpce.amazonaws.com`."
- "A *Zonal* DNS name includes the Availability Zone—for example, `{{vpce-1a2b3c4d-5e6f}}-us-east-1a.s3.us-east-1.vpce.amazonaws.com`."
- "Endpoint-specific S3 DNS names can be resolved from the S3 public DNS domain."
- Console shows "`*.vpce-0e25b8cdd720f900e-argc85vg.s3.us-east-1.vpce.amazonaws.com`"; "replace {{\*}} with ... `bucket`, `accesspoint`, `control`"; "to access a bucket, use a *DNS name* like this: `bucket.vpce-0e25b8cdd720f900e-argc85vg.s3.us-east-1.vpce.amazonaws.com`".
- CLI: "`aws s3 ls s3://{{my-bucket}}/ --region {{us-east-1}} --endpoint-url https://bucket.{{vpce-1a2b3c4d-5e6f.s3.us-east-1.vpce.amazonaws.com}}`"; Boto3 `endpoint_url='https://bucket.{{vpce-...}}'`.
- Private DNS: "With private DNS names enabled, Regional S3 DNS queries resolve to the private IP addresses of AWS PrivateLink for the following endpoints: + Regional bucket endpoints (for example, `s3.us-east-1.amazonaws.com` ...)". Default is "Enable private DNS only for inbound endpoints", which requires a gateway endpoint: "a gateway endpoint must be present in your VPC".
- Not supported over interface endpoints: "Legacy global endpoints", "S3 dash Region endpoints", "Transport Layer Security (TLS) 1.0", "(TLS) 1.1", "(TLS) 1.3", "Hybrid post-quantum Transport Layer Security (TLS)". Directory buckets: "AWS PrivateLink for S3" is listed as unsupported.

Gateway endpoints (https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html and https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html):
- Service name in console: "**com.amazonaws.**{{region}}**.s3**".
- "When you create a gateway endpoint, you select the VPC route tables for the subnets that you enable. The following route is automatically added to each route table that you select. The destination is a prefix list for the service owned by AWS and the target is the gateway endpoint." Table: "Destination {{prefix\_list\_id}} | Target {{gateway\_endpoint\_id}}".
- "Gateway endpoints do not use AWS PrivateLink, unlike other types of VPC endpoints." "There is no additional charge for using gateway endpoints."
- Comparison table (privatelink-interface-endpoints): Gateway "Use Amazon S3 public IP addresses" / "Use the same Amazon S3 DNS names" / "Do not allow access from on premises" / "Do not allow access from another AWS Region" / "Not billed"; Interface "Use private IP addresses from your VPC" / "Require endpoint-specific Amazon S3 DNS names" / "Allow access from on premises" / "Allow access from a VPC in another AWS Region by using VPC peering or AWS Transit Gateway" / "Billed". "In both cases, your network traffic remains on the AWS network."
- Route precedence: "We use the most specific route that matches the traffic to determine how to route the traffic (longest prefix match). ... If there is a route that sends all internet traffic (0.0.0.0/0) to an internet gateway, the endpoint route takes precedence for traffic destined for the service (Amazon S3 or DynamoDB) in the current Region." "Traffic that's destined for the service ... in a different Region goes to the internet gateway because prefix lists are specific to a Region."
- Without a gateway endpoint: "While traffic to Amazon S3 or DynamoDB traverses the internet gateway, it does not leave the AWS network."

### 5.2 Path-style deprecation — CONFIRMED as "will be discontinued", no date, no new-bucket cutoff

VirtualHosting page: "Currently, Amazon S3 supports both virtual-hosted–style and path-style URL access in all AWS Regions. However, path-style URLs will be discontinued in the future." and "**Important** Update (September 23, 2020) – To make sure that customers have the time that they need to transition to virtual-hosted–style URLs, we have decided to delay the deprecation of path-style URLs." No statement that path-style is already unavailable for buckets created after some date (NOT FOUND IN DOCS). Path-style is unavailable for directory buckets and Transfer Acceleration (quoted above).

### 5.3 HTTP/2 — NOT FOUND IN DOCS (no S3 statement either way)

- No page under `docs.aws.amazon.com/AmazonS3/` mentions HTTP/2. All S3 API request-syntax blocks are written `... HTTP/1.1` (e.g. HeadBucket `HEAD / HTTP/1.1`, GetObject, PutObject).
- The only AWS doc on SDK HTTP/2 (https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/http2.html): "Developers upgrading to the latest SDKs will automatically use HTTP/2 when it's supported by the service they're working with." and "The AWS SDK for Java 2.x features new APIs for event streaming that implement the HTTP/2 protocol. For examples of how to use these new APIs, see Working with Kinesis." — no mention of S3.
- CloudFront (not S3) documents HTTP/2 support (https://aws.amazon.com/about-aws/whats-new/2016/09/amazon-cloudfront-now-supports-http2). The optimizing-performance page recommends CloudFront "if you want higher transfer rates over a single HTTP connection".
- Non-authoritative corroboration (not an AWS doc, so not relied upon): an AWS re:Post thread reports `curl` negotiating HTTP/1.1 against S3.

### 5.4 TLS versions — CONFIRMED (1.2 and 1.3; 1.2 minimum)

- https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryptionInTransit.html — "Amazon S3 supports both HTTP and HTTPS protocols for data transmission." "Amazon S3 supports TLS 1.2 and TLS 1.3 for HTTPS connections across all API endpoints for all AWS Regions. S3 automatically negotiates the strongest TLS protection supported by your client software, and the S3 endpoint you are accessing. Current AWS tools (2014 or later) including the AWS SDKs and AWS CLI automatically default to TLS 1.3". "**Note** TLS 1.3 is supported in all S3 endpoints, except for AWS PrivateLink for Amazon S3 and Multi-Region Access Points." Policy key: "`s3:TlsVersion`" (example `"NumericLessThan": {"s3:TlsVersion": "1.3"}`); `aws:SecureTransport` for HTTPS-only.
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/network-isolation.html — "Clients must support Transport Layer Security (TLS) 1.2. We recommend also supporting TLS 1.3 and hybrid post-quantum key exchange." "Clients must also support cipher suites with Perfect Forward Secrecy (PFS) such as Ephemeral Diffie-Hellman (DHE) or Elliptic Curve Diffie-Hellman Ephemeral (ECDHE). Additionally, requests must be signed using AWS Signature V4 or AWS Signature V2".
- General Reference: regular endpoints "HTTP and HTTPS"; FIPS endpoints "HTTPS" only.
- Logging: "Both logging options [server access logs, CloudTrail] record the TLS version and cipher suite used in each request."

---

## 6. Observing the gateway-vs-public path

### 6.1 `DescribeRouteTables` route entries — CONFIRMED

URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Route.html — `destinationPrefixListId`: "The prefix of the AWS service. Type: String" ; `gatewayId`: "The ID of a gateway attached to your VPC. Type: String" ; `destinationCidrBlock`: "The IPv4 CIDR block used for the destination match." ; `origin`: "`CreateRouteTable` - The route was automatically created when the route table was created. `CreateRoute` - The route was manually added ... `EnableVgwRoutePropagation` ... Valid Values: `CreateRouteTable | CreateRoute | EnableVgwRoutePropagation`" ; `state`: "The `blackhole` state indicates that the route's target isn't available ... Valid Values: `active | blackhole`".

URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeRouteTables.html — filters "`route.destination-prefix-list-id` - The ID (prefix) of the AWS service specified in a route in the table." and "`route.gateway-id` - The ID of a gateway specified in a route in the table." The sample response shows only `igw-`/`local` routes; the `pl-…`→`vpce-…` pairing is documented on the gateway-endpoints page (Destination `{{prefix_list_id}}` / Target `{{gateway_endpoint_id}}`) and VPC_Route_Tables: "Each route specifies a destination (CIDR block or prefix list) and a target". "You can review the endpoint routes that we add to your route table, but you cannot modify or delete them."

### 6.2 `DescribeVpcEndpoints` / `VpcEndpoint` — CONFIRMED

URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_VpcEndpoint.html — `vpcEndpointType`: "Valid Values: `Interface | Gateway | GatewayLoadBalancer | Resource | ServiceNetwork`" ; `RouteTableIdSet.N`: "(Gateway endpoint) The IDs of the route tables associated with the endpoint." ; `DnsEntrySet.N`: "(Interface endpoint) The DNS entries for the endpoint. Type: Array of DnsEntry objects" (DnsEntry: `dnsName` "The DNS name.", `hostedZoneId` "The ID of the private hosted zone.") ; `privateDnsEnabled`: "(Interface endpoint) Indicates whether the VPC is associated with a private hosted zone." ; `SubnetIdSet.N` / `GroupSet.N` / `NetworkInterfaceIdSet.N` are all "(Interface endpoint)" ; `serviceName`: "The name of the service to which the endpoint is associated." ; `state`: "Valid Values: `PendingAcceptance | Pending | Available | Deleting | Deleted | Rejected | Failed | Expired | Partial`" ; `ipAddressType`: "`ipv4 | dualstack | ipv6`". CLI create example: `--vpc-endpoint-type Interface --private-dns-enabled --dns-options PrivateDnsOnlyForInboundResolverEndpoint=true`.

### 6.3 Prefix list lookups — CONFIRMED

URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribePrefixLists.html — "Describes available AWS services in a prefix list format, which includes the prefix list name and prefix list ID of the service and the IP address range for the service. We recommend that you use DescribeManagedPrefixLists instead." Filters: "`prefix-list-id`", "`prefix-list-name`". Sample: `<prefixListName>com.amazonaws.us-west-2.s3</prefixListName><prefixListId>pl-12345678</prefixListId><cidrSet><item>54.123.456.7/19</item></cidrSet>`.

URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_GetManagedPrefixListEntries.html — "Gets information about the entries for a specified managed prefix list." `PrefixListId` "Required: Yes"; `TargetVersion` "The default is the current version."; response `entrySet` items with `cidr` and `description`.

### 6.4 Can the guest see the gateway endpoint? — NOT FOUND IN DOCS as an explicit statement; implied "no"

No AWS page says "the instance's OS route table does not show the endpoint". What the docs do say:
- The route lives in the **VPC route table**, not the instance: "A *route table* contains a set of rules, called routes, that are used to determine where network traffic from your VPC is directed." (https://docs.aws.amazon.com/vpc/latest/userguide/how-it-works.html) and the endpoint route is added "to each route table that you select".
- The instance keeps using public S3 addresses and names: "When your instances access Amazon S3 or DynamoDB through a gateway endpoint, they access the service using its public endpoint." (gateway-endpoints) ; "Use Amazon S3 public IP addresses" / "Use the same Amazon S3 DNS names" (comparison table).
- The only instance-observable side effects documented: "The source IPv4 or IPv6 addresses from instances in your affected subnets as received by Amazon S3 change from public addresses to the private addresses in your VPC. An endpoint switches network routes, and disconnects open TCP connections. The previous connections that used public addresses are not resumed." (vpc-endpoints-s3)
- Policy-side detection: "You can't use the `aws:SourceIp` condition in an identity policy or a bucket policy for requests to Amazon S3 that traverse a VPC endpoint. Instead, use the `aws:VpcSourceIp` condition." and bucket policies keyed on `aws:sourceVpce` / `aws:sourceVpc`.

### 6.5 Does the S3 response reveal the path? — NOT FOUND IN DOCS (no header documented for this)

- `x-amz-id-2` / `x-amz-request-id` are documented only as troubleshooting tokens (quoted in 2.2). https://docs.aws.amazon.com/AmazonS3/latest/userguide/get-request-ids.html: "Request IDs come in pairs, are returned in every response that Amazon S3 processes (even the erroneous ones)". Example: `x-amz-request-id: 79104EXAMPLEB723` / `x-amz-id-2: IOWQ4fDEXAMPLEQM+ey7N9WgVhSnQ6JEXAMPLEZb7hSQDASK+Jd1vEXAMPLEa3Km`; in error bodies they appear as `<RequestId>` and `<HostId>`.
- The documented **server-side** path signal is CloudTrail (https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html): "**`vpcEndpointId`** Identifies the VPC endpoint in which requests were made from a VPC to another AWS service, such as Amazon EC2. ... Since: 1.04 Optional: True" ; "**`vpcEndpointAccountId`** Identifies the AWS account ID of the VPC endpoint owner for the corresponding endpoint for which a request has traversed." ; `sourceIPAddress`: "The IP address that the request was made from." ; `tlsDetails` with `tlsVersion`, `cipherSuite`, `clientProvidedHostHeader`, `keyExchange` ("Example values include `X25519MLKEM768` for post-quantum TLS 1.3, `x25519` for classical TLS 1.3, and `secp256r1` for TLS 1.2."). Also: "Both `x-amz-request-id` and `x-amz-id-2` contain information that helps you trace a request with Support. These values are the same as those that the service returns in the response ... so you can use them to match the event to the request." (S3 data events must be enabled on the trail for object-level calls.)

---

## 7. S3 Express One Zone sessions — CONFIRMED

URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateSession.html
- "Creates a session that establishes temporary security credentials to support fast authentication and authorization for the Zonal endpoint API operations on directory buckets."
- "you use IAM credentials to make the `CreateSession` API request on the bucket, which returns temporary security credentials that include the access key ID, secret access key, session token, and expiration. ... in your Zonal endpoint API requests, you sign your requests by applying the temporary security credentials of the session to the request headers and following the SigV4 protocol for authentication. You also apply the session token to the `x-amz-s3session-token` request header for authorization. Temporary security credentials are scoped to the bucket and expire after 5 minutes. After the expiration time, any calls that you make with those credentials will fail. ... Temporary credentials cannot be extended or refreshed beyond the original specified interval."
- "If you use AWS SDKs, SDKs handle the session token refreshes automatically to avoid service interruptions when a session expires."
- Request: `GET /?session HTTP/1.1` to "`Bucket-name.s3express-zone-id.region-code.amazonaws.com`"; "You must make requests for this API operation to the Zonal endpoint."
- `x-amz-create-session-mode`: "either `ReadWrite` or `ReadOnly`. If no session mode is specified, the default behavior attempts to create a session with the maximum allowable privilege. ... A `ReadOnly` session is constrained to execute the following Zonal endpoint API operations: `GetObject`, `HeadObject`, `ListObjectsV2`, `GetObjectAttributes`, `ListParts`, and `ListMultipartUploads`. Valid Values: `ReadOnly | ReadWrite`"
- Response XML: `<CreateSessionResult><Credentials><AccessKeyId>…</AccessKeyId><Expiration>timestamp</Expiration><SecretAccessKey>…</SecretAccessKey><SessionToken>…</SessionToken></Credentials></CreateSessionResult>`
- Exceptions: "the `CopyObject` API operation doesn't use the temporary security credentials returned from the `CreateSession` API operation" ; "the `HeadBucket` API operation doesn't use the temporary security credentials".
- Encryption settings cannot be overridden per request during a session: "In the Zonal endpoint API calls (except CopyObject and UploadPartCopy) using the REST API, you can't override the values of the encryption settings ... from the `CreateSession` request."

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-create-session.html — "To use Zonal endpoint API operations (object-level, or data plane operations), except for `CopyObject` and `HeadBucket`, you use the `CreateSession` API operation" ; "To protect your sessions, temporary security credentials expire after 5 minutes." ; "you can't modify the `SessionMode` parameter when using the AWS CLI or AWS SDKs." ; "All `CopyObject` and `HeadBucket` requests must be authenticated and signed by using IAM credentials. However, `CopyObject` and `HeadBucket` are still authorized by `s3express:CreateSession`".

URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance.html — "The AWS SDKs use the `CreateSession` API operation to request temporary credentials, and then automatically create and refresh tokens for you on your behalf every 5 minutes."

Session auth applies to zonal endpoints only — CONFIRMED: Regional operations use IAM directly, e.g. CreateBucket "You must have the `s3express:CreateBucket` permission in an IAM identity-based policy instead of a bucket policy" and ListDirectoryBuckets "`s3express:ListAllMyDirectoryBuckets` permission in an IAM identity-based policy".

---

## 8. Same-Region data transfer pricing — CONFIRMED (free), EC2 not named explicitly

URL: https://aws.amazon.com/s3/pricing/ — Data transfer section lists as free: "Data transferred in from the internet." ; "Data transferred out to Amazon CloudFront (CloudFront)." ; "Data transferred between S3 buckets in the same AWS Region." ; "Data transferred from an Amazon S3 bucket to any AWS service(s) within the same AWS Region as the S3 bucket (including to a different account in the same AWS Region)." ; plus "Data transferred out to the internet for the first 100GB per month". EC2 is not named separately; same-Region EC2↔S3 falls under "any AWS service(s) within the same AWS Region". Transfer Acceleration: "S3 Transfer Acceleration pricing is in addition to Data Transfer pricing." The pricing page does not mention VPC endpoints.

Gateway vs interface billing (privatelink-interface-endpoints comparison table): gateway "Not billed", interface "Billed"; gateway-endpoints page: "There is no additional charge for using gateway endpoints." Private-DNS-for-inbound-resolver design exists specifically so "you pay to use the interface endpoint only for traffic that can't use the gateway endpoint." (vpc-endpoints-s3)

---

## Source index

- https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadBucket.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketLocation.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListDirectoryBuckets.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_Bucket.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateBucket.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_BucketInfo.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_LocationInfo.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-naming-rules.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucketnamingrules.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
- https://docs.aws.amazon.com/AmazonS3/latest/developerguide/RESTCommonResponseHeaders.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-at-rest.html
- https://docs.aws.amazon.com/sdkref/latest/guide/feature-dataintegrity.html
- https://aws.amazon.com/about-aws/whats-new/2024/12/amazon-s3-default-data-integrity-protections
- https://aws.amazon.com/blogs/aws/introducing-default-data-integrity-protections-for-new-objects-in-amazon-s3/
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/storage-class-intro.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/glacier-storage-classes.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-data-residency.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-lzs-for-directory-buckets.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html
- https://docs.aws.amazon.com/general/latest/gr/s3.html
- https://docs.aws.amazon.com/AmazonS3/latest/developerguide/dual-stack-endpoints.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/transfer-acceleration.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/endpoint-directory-buckets-AZ.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html
- https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html
- https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
- https://docs.aws.amazon.com/vpc/latest/userguide/VPC_Route_Tables.html
- https://docs.aws.amazon.com/vpc/latest/userguide/how-it-works.html
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Route.html
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeRouteTables.html
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_VpcEndpoint.html
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DnsEntry.html
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribePrefixLists.html
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_GetManagedPrefixListEntries.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryptionInTransit.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/network-isolation.html
- https://docs.aws.amazon.com/sdk-for-java/latest/developer-guide/http2.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/get-request-ids.html
- https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateSession.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-create-session.html
- https://aws.amazon.com/s3/pricing/

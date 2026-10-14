# LedgerMath research, round 2: Amazon S3 facts from primary sources

Date of research: 2026-10-11
Scope: ten numbered questions about Amazon S3 as seen from EC2, for a benchmark that uploads fixtures once (1 byte to 100 GB) and reads them many times, from general purpose buckets and from directory buckets (S3 Express One Zone).

Source policy: every finding below is backed by a verbatim quote from docs.aws.amazon.com, aws.amazon.com/blogs, aws.amazon.com/about-aws/whats-new, or the AWS Price List API (pricing.us-east-1.amazonaws.com, an AWS-published JSON feed). Where no primary source was found the item says NOT FOUND. Nothing is filled in from memory.

Format per finding: (a) verbatim quote, (b) URL, (c) one line in my own words.

Method notes:
- aws.amazon.com/s3/pricing/ and aws.amazon.com/privatelink/pricing/ render their price tables with JavaScript; the fetched text contains prose but not the numeric tables. For the numbers I used the AWS Price List bulk API (offer files `AmazonS3`, `AmazonVPC`, `AWSDataTransfer`, region `us-east-1`). Each quote from that feed is the SKU's own `description` string, which is AWS-authored.
- Some pages were fetched through a summarizer that caps quotes at 125 characters; where that happened the quoted fragments are still verbatim but may be sentence pieces. I flag those with "(fragment)".

---

## 1. "Amazon S3 Files": does a product with this exact name exist?

Yes. Launched April 7, 2026.

**Launch date and name**
- Quote: "Posted: Apr 7, 2026" (fragment) and the post title "Announcing Amazon S3 Files, making S3 buckets accessible as file systems".
- URL: https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-s3-files
- Gloss: The What's New post is dated 7 April 2026 and uses the exact product name.

- Quote: "by Sébastien Stormacq on 07 APR 2026" and "I'm excited to announce Amazon S3 Files, a new file system that seamlessly connects any AWS compute resource" (fragment).
- URL: https://aws.amazon.com/blogs/aws/launching-s3-files-making-s3-buckets-accessible-as-file-systems
- Gloss: AWS News Blog launch post, same date.

**Docs URL and the product's own one-paragraph description**
- Quote: "S3 Files is a shared file system that connects any AWS compute resource directly with your data in Amazon S3. It provides fast, direct access to all of your S3 data as files with full file system semantics and low-latency performance, without your data ever leaving S3. Every file-based application, agent, and team can access and work with your S3 data as a file system using the tools they already depend on. Built using Amazon EFS, S3 Files gives you the performance and simplicity of a file system with the scalability, durability, and cost-effectiveness of S3. You can read, write, and organize data using file and directory operations, while S3 Files manages the synchronization of changes between your bucket and file system."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
- Gloss: This is the "What is S3 Files?" paragraph from the User Guide.

**What it is built on**
- Quote: "Built using Amazon EFS, S3 Files gives you the performance and simplicity of a file system with the scalability, durability, and cost-effectiveness of S3."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
- Gloss: Built on Amazon EFS, not on Mountpoint.

- Quote: "Under the hood, S3 Files uses Amazon Elastic File System (Amazon EFS) and delivers ~1ms latencies for active data."
- URL: https://aws.amazon.com/blogs/aws/launching-s3-files-making-s3-buckets-accessible-as-file-systems
- Gloss: The blog says the same thing and gives a latency figure.

**Does it present an S3 bucket as a mounted file system?**
- Quote: "When you create an S3 file system linked to your S3 bucket or to a prefix within it and mount it on a compute resource such as an EC2 instance or a Lambda function, S3 Files first presents a traversable view of your bucket's objects as files. As you navigate through directories and open files, associated metadata and contents are placed onto the file system's high-performance storage. When you read files, S3 Files loads file contents onto the high-performance storage on demand without duplicating your entire dataset. When you write data, your writes go to the high-performance storage and are synchronized back to your S3 bucket."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
- Gloss: Yes. You create a file system linked to a bucket (or prefix), add a mount target in your VPC, and NFS-mount it; reads and writes go through an EFS-backed "high-performance storage" layer that syncs with the bucket in both directions.

- Quote: "S3 Files supports the NFS version 4.2 and 4.1 protocols. It provides file-system-access semantics, such as read-after-write data consistency, file locking, and POSIX permissions."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
- Gloss: Protocol is NFSv4.1/4.2.

- Quote: "A mount target provides network access to your file system within a single Availability Zone in your VPC. You need at least one mount target to access your file system from compute resources, and you can create a maximum of one mount target per Availability Zone."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
- Gloss: Mount targets are per-AZ ENIs, as with EFS.

- Quote (blog, mount command shown verbatim): `sudo mount -t s3files fs-0aa860d05df9afdfe:/ /home/ec2-user/s3files` and "You can access any general purpose bucket as a native file system on your…" (fragment).
- URL: https://aws.amazon.com/blogs/aws/launching-s3-files-making-s3-buckets-accessible-as-file-systems
- Gloss: Mount type is `s3files` (via the EFS utils driver); the blog says "general purpose bucket", so directory buckets are not mentioned as supported.

- Quote: "Supported compute services to mount your S3 file systems are Amazon EC2, AWS Lambda, Amazon EKS, and Amazon ECS."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
- Gloss: EC2 is a supported mount client.

**Read path detail that matters for a benchmark**
- Quote: "S3 Files streams file reads directly from your S3 bucket in two cases: when the file's data is not stored in the file system's high-performance storage, and for large reads >= 1 MiB, even when the data also resides on the file system's high-performance storage."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
- Gloss: Reads of 1 MiB or larger bypass the EFS layer and stream from S3; small files (default < 128 KiB) are cached in the EFS layer.

**Limits**
- Quote: "| Maximum file size | 52,673,613,135,872 bytes (48 TiB) |"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-quotas.html
- Gloss: Max file size through S3 Files is 48 TiB.

**Pricing page URL and billing basis**
- Quote: "You pay a storage rate for the fraction of active data resident on the high-performance storage, and you pay file system access charges for reading from and writing to your file system's high performance storage. ... These reads incur only standard S3 GET request cost with no file system access charge. The file system access charges apply to synchronization operations: importing data onto the file system incurs write charges, and exporting changes back to S3 incurs read charges. For more information, see How S3 Files is metered. For current pricing, see the S3 Files pricing page."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html (the "S3 Files pricing page" link resolves to https://aws.amazon.com/s3/pricing/, where S3 Files has its own "Files" tab)
- Gloss: Pricing lives on the main S3 pricing page under a "Files" tab; dollar figures are JS-rendered and were not captured.

- Quote (pricing page, Files tab, fragment): "With S3 Files, you pay a storage charge for the fraction of active data on the file system's high-performance storage,"
- URL: https://aws.amazon.com/s3/pricing/
- Gloss: Confirms the tab exists.

**Region availability**
- Quote: "S3 Files is now generally available in 34 AWS Regions." (fragment; the post directs readers to the AWS Capabilities tool at https://builder.aws.com/build/capabilities for the list)
- URL: https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-s3-files
- Gloss: 34 Regions per the What's New post.

- Quote: "S3 Files is available today in all commercial AWS Regions."
- URL: https://aws.amazon.com/blogs/aws/launching-s3-files-making-s3-buckets-accessible-as-file-systems
- Gloss: The blog says "all commercial Regions". The two primary sources differ in wording; I did not find a per-Region list in a fetchable primary page.

Because the product exists, the "nearest things" list (Mountpoint, File Gateway, FSx for Lustre) was not researched.

---

## 2. Multipart upload limits

Source page: "Amazon S3 multipart upload limits".

- Quote (the whole table, verbatim):
  "| Item | Specification |
  | Maximum object size | 48.8 TiB |
  | Maximum number of parts per upload | 10,000 |
  | Part numbers | 1 to 10,000 (inclusive) |
  | Part size | 5 MiB to 5 GiB. There is no minimum size limit on the last part of your multipart upload. |
  | Maximum number of parts returned for a list parts request | 1000 |
  | Maximum number of multipart uploads returned in a list multipart uploads request | 1000 |"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- Gloss: Min part 5 MiB, max part 5 GiB, max 10,000 parts, max object 48.8 TiB (which is exactly 10,000 x 5 GiB = 50,000 GiB), last part exempt from the minimum.

- Quote: "There is no minimum size limit on the last part of your multipart upload."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- Gloss: The last-part exception, stated in prose above the table as well.

- Quote: "In general, when your object size reaches 100 MB, you should consider using multipart uploads instead of uploading the object in a single operation."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- Gloss: AWS's threshold recommendation.

**Maximum object size for a single PUT**
- Quote: "Upload an object in a single operation by using the AWS SDKs, REST API, or AWS CLI – With a single PUT operation, you can upload a single object up to 5 GB in size."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html
- Gloss: Single PUT caps at 5 GB.

- Quote: "Upload an object in parts by using the AWS SDKs, REST API, or AWS CLI – Using the multipart upload API operation, you can upload a single large object, up to 50 TB in size." and "You can use a multipart upload for objects from 5 MB to 50 TB in size."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html
- Gloss: This page says "50 TB" where the limits table says "48.8 TiB"; both are AWS pages and both are current.

- Quote: "Posted on: Dec 2, 2025" and "Amazon S3 increased the maximum object size to 50 TB, a 10x increase from the previous 5 TB limit." and "Amazon S3 supports objects up to 50 TB in all AWS Regions."
- URL: https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-maximum-object-size-50-tb/
- Gloss: The limit was raised from 5 TB to 50 TB on 2 December 2025.

- Quote: "To upload files greater than 5 TB, use the S3 Transfer Manager in the Java v1/v2, Python, or AWS CLI SDKs."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html
- Gloss: Above 5 TB AWS points you at the SDK transfer managers.

---

## 3. Checksums and multipart upload

Source pages: "Checking object integrity in Amazon S3" and its sub-page "Checking object integrity for data uploads in Amazon S3".

**Which algorithms can be FULL_OBJECT vs COMPOSITE on a multipart upload**
- Quote (the whole table, verbatim):
  "The following table indicates which checksum algorithm type is supported for each checksum algorithm in a multipart upload:
  | Checksum algorithm | Full object | Composite |
  | CRC-64/NVME (CRC64NVME) | Yes | No |
  | CRC-32 (CRC32) | Yes | Yes |
  | CRC-32C (CRC32C) | Yes | Yes |
  | SHA-1 (SHA1) | No | Yes |
  | SHA-256 (SHA256) | No | Yes |
  | MD5 (MD5) | No | Yes |
  | XXHash64 (XXHASH64) | No | Yes |
  | XXHash3 (XXHASH3) | No | Yes |
  | XXHash128 (XXHASH128) | No | Yes |
  | SHA-512 (SHA512) | No | Yes |"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- Gloss: FULL_OBJECT on multipart is only CRC64NVME, CRC32, CRC32C. CRC64NVME is FULL_OBJECT only. SHA1, SHA256, MD5, SHA512 and the XXHash family are COMPOSITE only.

- Quote: "For full object checksums, you can use CRC-64/NVME (CRC64NVME), CRC-32 (CRC32), or CRC-32C (CRC32C) checksum algorithms in S3. Full object checksums in multipart uploads are only available for CRC-based checksums because they can linearize into a full object checksum. This linearization allows Amazon S3 to parallelize your requests for improved performance. In particular, S3 can compute the checksum of the whole object from the part-level checksums. This type of validation isn't available for other algorithms, such as SHA and MD5. Because S3 has default integrity protections, if objects are uploaded without a checksum, S3 automatically attaches the recommended full object CRC-64/NVME (CRC64NVME) checksum algorithm to the object."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- Gloss: The reason: CRCs combine linearly; SHA/MD5 don't. Objects uploaded without any checksum get a FULL_OBJECT CRC64NVME attached by S3.

- Quote: "The CRC64NVME checksum is always a full object checksum."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html (x-amz-checksum-crc64nvme request header)
- Gloss: API reference states the same.

- Quote: "Objects that you upload using PutObject use the full object checksum type. You do not need to specify a checksum type."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- Gloss: Single-part PUTs are always FULL_OBJECT.

- Quote: "Note: The CRC64NVME checksum algorithm is the default checksum algorithm used for checksum calculations."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
- Gloss: Default algorithm is CRC64NVME.

- Quote: "When using multipart uploads with the new checksum algorithms (MD5, XXHash3, XXHash64, XXHash128, SHA-512), you must specify the checksum algorithm in the CreateMultipartUpload request using the x-amz-checksum-algorithm header. If you provide a checksum value in the CompleteMultipartUpload request (for example, x-amz-checksum-sha512) without having specified the algorithm in CreateMultipartUpload, the request will fail with an InvalidRequest error." and "For existing checksum algorithms (CRC32, CRC32C, SHA-1, SHA-256), if the algorithm is not specified in CreateMultipartUpload, any checksum header provided in CompleteMultipartUpload is currently accepted but not validated or stored with the object. We recommend always specifying the algorithm in CreateMultipartUpload to ensure your checksums are validated and stored."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- Gloss: Declare the algorithm at CreateMultipartUpload or the final checksum may be silently dropped.

**`x-amz-checksum-type` on HeadObject**
- Quote: "x-amz-checksum-type: The checksum type, which determines how part-level checksums are combined to create an object-level checksum for multipart objects. You can use this header response to verify that the checksum type that is received is the same checksum type that was specified in CreateMultipartUpload request. ... Valid Values: COMPOSITE | FULL_OBJECT"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
- Gloss: HeadObject returns COMPOSITE or FULL_OBJECT in this header.

- Quote (CreateMultipartUpload request header): "x-amz-checksum-type: Indicates the checksum type that you want Amazon S3 to use to calculate the object's checksum value. ... Valid Values: COMPOSITE | FULL_OBJECT" and "x-amz-checksum-algorithm ... Valid Values: CRC32 | CRC32C | SHA1 | SHA256 | CRC64NVME | SHA512 | MD5 | XXHASH64 | XXHASH3 | XXHASH128"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html
- Gloss: You choose the type at CreateMultipartUpload.

**Request header needed to get checksums back**
- Quote: "x-amz-checksum-mode: To retrieve the checksum, this parameter must be enabled. General purpose buckets - If you enable checksum mode and the object is uploaded with a checksum and encrypted with an AWS Key Management Service (AWS KMS) key, you must have permission to use the kms:Decrypt action to retrieve the checksum. Directory buckets - If you enable ChecksumMode and the object is encrypted with AWS Key Management Service (AWS KMS), you must also have the kms:GenerateDataKey and kms:Decrypt permissions in IAM identity-based policies and AWS KMS key policies for the AWS KMS key to retrieve the checksum of the object. Valid Values: ENABLED"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
- Gloss: Send `x-amz-checksum-mode: ENABLED` on HeadObject (and GetObject) or no `x-amz-checksum-*` headers come back.

**ETag format for multipart objects, and ETag-is-not-MD5**
- Quote: "When an object is uploaded as a multipart upload, the entity tag (ETag) for the object is not an MD5 digest of the entire object. Instead, Amazon S3 calculates the MD5 digest of each individual part as it is uploaded. The MD5 digests are used to determine the ETag for the final object. Amazon S3 concatenates the bytes for the MD5 digests together and then calculates the MD5 digest of these concatenated values. During the final ETag creation step, Amazon S3 adds a dash with the total number of parts to the end."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- Gloss: Multipart ETag = MD5(concat(MD5(part_i))) followed by "-N" where N is the part count.

- Quote: "If an object is created by the PutObject, PostObject, or CopyObject operation, or through the AWS Management Console, and that object is also plaintext or encrypted by server-side encryption with Amazon S3 managed keys (SSE-S3), that object has an ETag that is an MD5 digest of its object data. If an object is created by the PutObject, PostObject, or CopyObject operation, or through the AWS Management Console, and that object is encrypted by server-side encryption with customer-provided keys (SSE-C) or server-side encryption with AWS Key Management Service (AWS KMS) keys (SSE-KMS), that object has an ETag that is not an MD5 digest of its object data. If an object is created by either the multipart upload process or the UploadPartCopy operation, the object's ETag is not an MD5 digest, regardless of the method of encryption. If an object is larger than 16 MB, the AWS Management Console uploads or copies that object as a multipart upload, and therefore the ETag isn't an MD5 digest."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- Gloss: ETag is an MD5 only for single-part, SSE-S3-or-plaintext objects. Multipart, SSE-KMS, SSE-C: not MD5.

- Quote (API reference, same rule): "The ETag may or may not be an MD5 digest of the object data. Whether or not it is depends on how the object was created and how it is encrypted as described below: Objects created by the PUT Object, POST Object, or Copy operation, or through the AWS Management Console, and are encrypted by SSE-S3 or plaintext, have ETags that are an MD5 digest of their object data. Objects created by the PUT Object, POST Object, or Copy operation, or through the AWS Management Console, and are encrypted by SSE-C or SSE-KMS, have ETags that are not an MD5 digest of their object data. If an object is created by either the Multipart Upload or Part Copy operation, the ETag is not an MD5 digest, regardless of the method of encryption. If an object is larger than 16 MB, the AWS Management Console will upload or copy that object as a Multipart Upload, and therefore the ETag will not be an MD5 digest. Directory buckets - MD5 is not supported by directory buckets."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_Object.html
- Gloss: Same rule in the API reference, plus the directory-bucket caveat.

- Quote: "ETag: An entity tag (ETag) is an opaque identifier assigned by a web server to a specific version of a resource found at a URL."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
- Gloss: HeadObject's own ETag description makes no MD5 promise.

**Default-integrity announcement (context)**
- Quote: "Posted: Dec 1, 2024" and "Additionally, S3 now stores a CRC-based whole-object checksum in object metadata, even for multipart uploads," (fragment) and "S3 also supports five additional checksum algorithms, CRC64NVME, CRC32, CRC32C, SHA-1, and SHA-256," (fragment).
- URL: https://aws.amazon.com/about-aws/whats-new/2024/12/amazon-s3-default-data-integrity-protections
- Gloss: The whole-object CRC default dates from December 2024.

---

## 4. Directory buckets (S3 Express One Zone) and checksums; multipart on directory buckets

**Which checksum algorithms directory buckets support**
- Quote: "Directory buckets offer you the option to choose the checksum algorithm that is used to validate your data during upload or download. You can select one of the following Secure Hash Algorithms (SHA) or Cyclic Redundancy Check (CRC) data-integrity check algorithms: CRC32, CRC32C, SHA-1, and SHA-256. MD5-based checksums are not supported with the S3 Express One Zone storage class. CRC32 is the default checksum used by the AWS SDKs when transmitting data to or from directory buckets. We recommend using CRC32 and CRC32C for the best performance with directory buckets."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance.html#s3-express-optimizing-performance-checksums
- Gloss: The directory-bucket docs list four algorithms: CRC32, CRC32C, SHA-1, SHA-256. MD5 is excluded. SDK default for directory buckets is CRC32.

- Quote: "When you upload an object to, you can specify a checksum algorithm to check object integrity. MD5 is not supported for directory buckets. You can specify one of the following Secure Hash Algorithms (SHA) or Cyclic Redundancy Check (CRC) data-integrity check algorithms: CRC32, CRC32C, SHA-1, SHA-256" (list rendered inline; the typo "upload an object to," is in the source)
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html#s3-express-mpuchecksums
- Gloss: The directory-bucket multipart page lists the same four.

- Quote: "For directory buckets, when you use AWS SDKs, CRC32 is the default checksum algorithm that's used for performance."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html (x-amz-sdk-checksum-algorithm)
- Gloss: API reference agrees on the CRC32 SDK default for directory buckets.

- Quote: "The following Amazon S3 features are not supported by directory buckets: ... MD5 checksums ..."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html#s3-express-differences-unsupported-features
- Gloss: MD5 is on the unsupported list.

**Is CRC64NVME supported for directory buckets?**
- NOT FOUND as an explicit statement either way. The two directory-bucket User Guide pages above enumerate CRC32, CRC32C, SHA-1, SHA-256 and do not mention CRC64NVME. The API reference lists CRC64NVME in `Valid Values` for PutObject and CreateMultipartUpload without a directory-bucket exclusion note, and the HeadObject `x-amz-checksum-crc64nvme` response header carries no "not supported for directory buckets" note (other headers on that page do carry such notes). A site-restricted search for "CRC64NVME" with "directory buckets" returned no page stating support or non-support. The Dec 2024 default-integrity announcement does not mention directory buckets.
- URLs checked: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance.html , https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html , https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html , https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html , https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html , https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
- Gloss: The docs that are specifically about directory buckets omit CRC64NVME from the supported list; nothing says it is rejected. This needs an empirical check.

**ETags on directory buckets**
- Quote: "ETags and checksums – Entity tags (ETags) for directory buckets are random alphanumeric strings unique to the object and not MD5 checksums."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html
- Gloss: Directory-bucket ETags are opaque; never an MD5, even for single-part PUT.

- Quote: "Directory buckets - The ETag for the object in a directory bucket isn't the MD5 digest of the object."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
- Gloss: Same, from the API reference.

**Do directory buckets support multipart upload, and what differs**
- Quote: "Multipart uploads – You can upload and copy large objects that are stored in directory buckets by using the multipart upload process. However, the following are some differences when using the multipart upload process with objects stored in directory buckets. ... The object creation date is the completion date of the multipart upload. Multipart part numbers must use consecutive part numbers. If you try to complete a multipart upload request with nonconsecutive part numbers, Amazon S3 generates an HTTP 400 (Bad Request) error. The initiator of a multipart upload can abort the multipart upload request only if they have been granted explicit allow access to AbortMultipartUpload through the s3express:CreateSession permission."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html
- Gloss: Yes, supported; part numbers must be consecutive (1, 2, 3...), creation date is the complete time.

- Quote: "When uploading a part, in addition to the upload ID, you must specify a part number. When you're using a multipart upload with S3 Express One Zone, the multipart part numbers must be consecutive part numbers. If you try to complete a multipart upload request with nonconsecutive part numbers, an HTTP 400 Bad Request (Invalid Part Order) error is generated."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html
- Gloss: Error code name is "Invalid Part Order".

- Quote: "Your complete multipart upload request must include the upload ID and a list of both part numbers and their corresponding ETag values. The Amazon S3 response includes an ETag that uniquely identifies the combined object data. This ETag is not an MD5 hash of the object data."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html
- Gloss: Same ETag caveat for the assembled object.

**Directory-bucket-specific part size / parts count / object size limits**
- NOT FOUND as a separate prose limit. The directory-bucket multipart page gives no limits table of its own. Its Python sample carries the comment "Minimum 5 MiB, Maximum 5 GiB. There is no minimum size for the last part of your multipart upload." which matches the general limits page, and the general limits page (https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) does not carve out directory buckets. The 50 TB announcement says the new maximum applies "in all S3 storage classes" (fragment).
- URLs: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html , https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html , https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-maximum-object-size-50-tb/
- Gloss: No evidence of different numeric limits for directory buckets; only the consecutive-part-number rule and the opaque ETag.

**Other directory-bucket facts that surfaced**
- Quote: "The following Amazon S3 features are not supported by directory buckets: AWS managed policies, AWS PrivateLink for S3, MD5 checksums, Multi-factor authentication (MFA) delete, S3 Object Lock, Requester Pays, S3 Access Grants, S3 Event Notifications, S3 Lifecycle transition actions, S3 Multi-Region Access Points, S3 Object Lambda Access Points, S3 Versioning, S3 Replication, Object tags, S3 Select, Server access logs, Static website hosting, S3 Storage Lens, S3 Storage Lens groups, S3 Transfer Acceleration, Dual-layer server-side encryption with AWS Key Management Service (AWS KMS) keys (DSSE-KMS), Server-side encryption with customer-provided keys (SSE-C), The option to copy an existing bucket's settings when creating a new bucket in the Amazon S3 console, Enhanced access denied (HTTP 403 Forbidden) error messages"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html
- Gloss: The unsupported list; "AWS PrivateLink for S3" is relevant to question 5.

---

## 5. S3 interface endpoints (AWS PrivateLink for Amazon S3)

**DNS name formats**
- Quote: "When you create an interface endpoint, Amazon S3 generates two types of endpoint-specific, S3 DNS names: Regional and zonal. A Regional DNS name includes a unique VPC endpoint ID, a service identifier, the AWS Region, and vpce.amazonaws.com in its name. For example, for VPC endpoint ID vpce-1a2b3c4d, the DNS name generated might be similar to vpce-1a2b3c4d-5e6f.s3.us-east-1.vpce.amazonaws.com. A Zonal DNS name includes the Availability Zone—for example, vpce-1a2b3c4d-5e6f-us-east-1a.s3.us-east-1.vpce.amazonaws.com. You might use this option if your architecture isolates Availability Zones. For example, you could use it for fault containment or to reduce Regional data transfer costs. Endpoint-specific S3 DNS names can be resolved from the S3 public DNS domain."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#accessing-s3-interface-endpoints
- Gloss: Regional: `<vpce-id>-<suffix>.s3.<region>.vpce.amazonaws.com`. Zonal: `<vpce-id>-<suffix>-<az>.s3.<region>.vpce.amazonaws.com`. Both resolve from public DNS.

- Quote: "In this example, the VPC endpoint ID (vpce-id) is vpce-0e25b8cdd720f900e and the DNS name is *.vpce-0e25b8cdd720f900e-argc85vg.s3.us-east-1.vpce.amazonaws.com. When using the DNS name to access a resource, replace * with the appropriate value. The appropriate values to use in place of * are as follows: bucket, accesspoint, control. For example, to access a bucket, use a DNS name like this: bucket.vpce-0e25b8cdd720f900e-argc85vg.s3.us-east-1.vpce.amazonaws.com"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#accessing-bucket-and-aps-from-interface-endpoints
- Gloss: The bucket-style name is `bucket.<vpce-id>-<suffix>.s3.<region>.vpce.amazonaws.com`, used as `--endpoint-url`; the bucket itself is then a virtual-host prefix or path on that name.

- Quote: "If you create an interface endpoint that uses the FIPS service name com.amazonaws.region.s3-fips, Amazon S3 generates endpoint-specific DNS names. These names include the s3-fips service identifier. For example, vpce-1a2b3c4d-5e6f.s3-fips.us-east-1.vpce.amazonaws.com."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html
- Gloss: FIPS variant swaps `s3` for `s3-fips`.

**Private DNS for S3 interface endpoints and what it does to `s3.<region>.amazonaws.com`**
- Quote: "With private DNS names enabled, Regional S3 DNS queries resolve to the private IP addresses of AWS PrivateLink for the following endpoints: Regional bucket endpoints (for example, s3.us-east-1.amazonaws.com, or s3-fips.us-east-1.amazonaws.com for FIPS), Control endpoints (for example, s3-control.us-east-1.amazonaws.com, or s3-control-fips.us-east-1.amazonaws.com for FIPS), Access point endpoints (for example, s3-accesspoint.us-east-1.amazonaws.com, or s3-accesspoint-fips.us-east-1.amazonaws.com for FIPS)"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#private-dns
- Gloss: Yes, private DNS can be enabled; with it on, the ordinary `s3.<region>.amazonaws.com` name resolves inside the VPC to the interface endpoint's private IPs.

- Quote: "When you enable private DNS names on an existing or new VPC interface endpoint for Amazon S3, the Enable private DNS only for inbound endpoints option is selected by default. If this option is selected, your applications use only interface endpoints for your on-premises traffic. This in-VPC traffic automatically uses the lower-cost gateway endpoints. Alternatively, you can clear Enable private DNS only for inbound endpoints to route all S3 requests over your interface endpoint."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#private-dns
- Gloss: The default sub-option ("only for inbound endpoints") keeps in-VPC traffic on the gateway endpoint; clearing it sends all in-VPC S3 traffic through the interface endpoint.

- Quote: "If you configure private DNS for your interface endpoint for Amazon S3 but do not configure private DNS only for the inbound Resolver endpoint, requests from both your on-premises network and your VPC use the interface endpoint to access Amazon S3. Therefore, you pay to use the interface endpoint for traffic from the VPC, instead of using the gateway endpoint for no additional charge."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html#private-dns-s3
- Gloss: PrivateLink Guide version of the same rule, with the cost consequence spelled out.

- Quote: "To take advantage of the lowest cost network path when using Enable private DNS only for inbound endpoints, a gateway endpoint must be present in your VPC. ... When enabling Private DNS for inbound resolver only, the dnsRecordIpType of the gateway endpoint must either match that of interface endpoint or be service defined."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#private-dns
- Gloss: The inbound-only mode requires a gateway endpoint to exist.

- Quote (CLI): "If you don't specify a value for PrivateDnsOnlyForInboundResolverEndpoint, it will default to true." and the example `aws ec2 create-vpc-endpoint ... --vpc-endpoint-type Interface --private-dns-enabled ... --dns-options PrivateDnsOnlyForInboundResolverEndpoint=true`
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#private-dns
- Gloss: The API knob is `--private-dns-enabled` plus `--dns-options PrivateDnsOnlyForInboundResolverEndpoint=<bool>`.

**Restrictions**
- Quote: "Interface endpoints for Amazon S3 does not support the following: Website endpoints, Legacy global endpoints, S3 dash Region endpoints, Using CopyObject or UploadPartCopy between buckets in different AWS Regions, Transport Layer Security (TLS) 1.0, Transport Layer Security (TLS) 1.1, Transport Layer Security (TLS) 1.3, Hybrid post-quantum Transport Layer Security (TLS)"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#privatelink-limitations
- Gloss: TLS 1.3 is listed as not supported over the interface endpoint, so sessions negotiate TLS 1.2.

**Pricing basis**
- Quote (fragments from the pricing page): "You will be billed for each hour that your VPC endpoint remains provisioned in each Availability Zone," "irrespective of the state of its association with the service (learn more)." "Each partial VPC endpoint-hour consumed is billed as a full hour." "Data processing charges apply for each Gigabyte processed through the VPC endpoint" "regardless of the traffic's source or destination."
- URL: https://aws.amazon.com/privatelink/pricing/
- Gloss: Hourly per endpoint per AZ, plus per GB processed.

- Quote (pricing page table rows): "Pricing per GB of Data Processed ($)" "First 1 PB" "$0.01"; "Next 4 PB" "$0.006"; "Anything over 5 PB" "$0.004" and "Below pricing tiers apply on the total data processed by all Interface Endpoints in an AWS Region" (fragment).
- URL: https://aws.amazon.com/privatelink/pricing/
- Gloss: Per-GB tiers. The page's hourly-rate table did not render in the fetch; the only hourly figure in captured text is in an example: "you will be charged $0.01 per hour for each endpoint ENI." (fragment).

- Quote (AWS Price List API, offer AmazonVPC, us-east-1, publicationDate 2026-09-17T19:05:28Z): usagetype `USE1-VpcEndpoint-Hours`, "$0.01 per VPC Endpoint Hour" ($0.0100000000 per Hrs); usagetype `USE1-VpcEndpoint-Bytes`: "$0.01 per GB for upto 1 PB monthly data processed by VPC Endpoints", "$0.006 per GB for more than 1 PB and less than 5 PB monthly data processed by VPC Endpoints", "$0.004 per GB for more than 5 PB monthly data processed by VPC Endpoints".
- URL: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/us-east-1/index.json
- Gloss: In us-east-1 an interface endpoint costs $0.01 per hour per AZ plus $0.01/GB for the first PB.

- Quote: "| Not billed | Billed |" (row of the gateway-vs-interface comparison table: "Gateway endpoints for Amazon S3 ... Not billed"; "Interface endpoints for Amazon S3 ... Billed")
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#types-of-vpc-endpoints-for-s3
- Gloss: The S3 User Guide itself says gateway = not billed, interface = billed.

**Are directory buckets / S3 Express One Zone reachable through interface endpoints?**
- Quote: "The following Amazon S3 features are not supported by directory buckets: ... AWS PrivateLink for S3 ..."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html#s3-express-differences-unsupported-features
- Gloss: No. PrivateLink (interface endpoints) is explicitly unsupported for directory buckets.

- Quote: "You can access both Zonal and Regional API operations through gateway virtual private cloud (VPC) endpoints." and "You can access directory buckets and objects inside from your VPC by using gateway VPC endpoints. Directory buckets use Regional and Zonal API endpoints. Depending on the Amazon S3 API operation that you use, either a Regional or Zonal endpoint is required. There is no additional charge for using gateway endpoints."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-networking.html
- Gloss: Directory buckets are reached via a gateway endpoint (service `s3express`) only.

**How a client proves a request went through the interface endpoint (CloudTrail)**
- Quote: "vpcEndpointId: Identifies the VPC endpoint in which requests were made from a VPC to another AWS service, such as Amazon EC2. For events originated by AWS and through an AWS service's VPC, this field is usually AWS Internal or the service name. Since: 1.04 Optional: True"
- URL: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html
- Gloss: The CloudTrail record field is `vpcEndpointId`; present when the call traversed a VPC endpoint.

- Quote: "vpcEndpointAccountId: Identifies the AWS account ID of the VPC endpoint owner for the corresponding endpoint for which a request has traversed. For events originated by AWS and through an AWS service's VPC, this field is usually AWS Internal or the service name. Since: 1.09 Optional: True"
- URL: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html
- Gloss: Companion field giving the endpoint owner's account.

- Quote: "tlsDetails: Shows information about the Transport Layer Security (TLS) version, cipher suites, and the fully qualified domain name (FQDN) of the client-provided host name used in the service API call, which is typically the FQDN of the service endpoint. ... clientProvidedHostHeader - The client-provided host name used in the service API call, which is typically the FQDN of the service endpoint."
- URL: https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html
- Gloss: `tlsDetails.clientProvidedHostHeader` records the Host header, which would show the `*.vpce.amazonaws.com` name if the client used it.

- Quote (bucket-policy side): "The aws:sourceVpce condition specifies the endpoint and doesn't require an Amazon Resource Name (ARN) for the VPC endpoint resource, only the endpoint ID."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html#privatelink-example-restrict-access-to-vpc-endpoint
- Gloss: `aws:sourceVpce` is the policy condition key that matches the same ID.

---

## 6. S3 gateway endpoints

**Free**
- Quote: "There is no additional charge for using gateway endpoints."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html
- Gloss: Gateway endpoints cost nothing.

- Quote: "Pricing: There is no additional charge for using gateway endpoints."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
- Gloss: Repeated on the general gateway-endpoints page.

**Only visible as a route-table entry with a prefix list**
- Quote: "When you create a gateway endpoint, you select the VPC route tables for the subnets that you enable. The following route is automatically added to each route table that you select. The destination is a prefix list for the service owned by AWS and the target is the gateway endpoint. | Destination | Target | | prefix_list_id | gateway_endpoint_id |"
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html#gateway-endpoint-routing
- Gloss: The endpoint manifests as a route whose destination is `pl-xxxx` and whose target is `vpce-xxxx`.

- Quote: "You can review the endpoint routes that we add to your route table, but you cannot modify or delete them. To add an endpoint route to a route table, associate it with the gateway endpoint. We delete the endpoint route when you disassociate the route table from the gateway endpoint or when you delete the gateway endpoint."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html#gateway-endpoint-routing
- Gloss: The route is managed by AWS and read-only.

- Quote: "Gateway VPC endpoints provide reliable connectivity to Amazon S3 and DynamoDB without requiring an internet gateway or a NAT device for your VPC. Gateway endpoints do not use AWS PrivateLink, unlike other types of VPC endpoints."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
- Gloss: Gateway endpoints are routing constructs, not PrivateLink ENIs, so there is no ENI or private IP to observe.

- Quote: "When your instances access Amazon S3 or DynamoDB through a gateway endpoint, they access the service using its public endpoint."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html#gateway-endpoint-security
- Gloss: Client still talks to S3's public IPs and the ordinary `s3.<region>.amazonaws.com` name.

- Quote: "The source IPv4 or IPv6 addresses from instances in your affected subnets as received by Amazon S3 change from public addresses to the private addresses in your VPC. An endpoint switches network routes, and disconnects open TCP connections."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html#gateway-endpoint-considerations-s3
- Gloss: Creating/modifying a gateway endpoint drops live TCP connections to S3.

**DescribeRouteTables / DescribePrefixLists fields**
- Quote (EC2 API `Route` data type, as returned by DescribeRouteTables): "destinationPrefixListId: The prefix of the AWS service. Type: String" and "gatewayId: The ID of a gateway attached to your VPC. Type: String" and "origin: Describes how the route was created. CreateRouteTable - The route was automatically created when the route table was created. CreateRoute - The route was manually added to the route table. EnableVgwRoutePropagation - The route was propagated by route propagation." and "state: The state of the route. The blackhole state indicates that the route's target isn't available ... Valid Values: active | blackhole"
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Route.html
- Gloss: In DescribeRouteTables output the gateway-endpoint route has `DestinationPrefixListId` = `pl-...` and `GatewayId` = `vpce-...`.

- Quote: "DescribePrefixLists: Describes available AWS services in a prefix list format, which includes the prefix list name and prefix list ID of the service and the IP address range for the service. We recommend that you use DescribeManagedPrefixLists instead." and the sample response "<prefixListName>com.amazonaws.us-west-2.s3</prefixListName> <prefixListId>pl-12345678</prefixListId> <cidrSet><item>54.123.456.7/19</item></cidrSet>"
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribePrefixLists.html
- Gloss: DescribePrefixLists returns `prefixListSet[].prefixListName` (e.g. `com.amazonaws.<region>.s3`), `prefixListId`, and `cidrSet`.

- Quote: "The rules for the security groups for your instances that access Amazon S3 through a gateway endpoint must allow traffic to and from Amazon S3. You can reference the ID of the prefix list for Amazon S3 in security group rules."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html#gateway-endpoint-considerations-s3
- Gloss: The same prefix list ID is usable in security groups.

**Separate gateway endpoint service name for S3 Express One Zone**
- Quote: "If your Amazon S3 data is stored in general purpose buckets, select com.amazonaws.region.s3. If your Amazon S3 data is stored in directory buckets, select com.amazonaws.region.s3express."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html#create-gateway-endpoint-s3
- Gloss: Two distinct gateway services: `com.amazonaws.<region>.s3` and `com.amazonaws.<region>.s3express`.

- Quote: "For Services, add the filter Type=Gateway and then choose the option button next to com.amazonaws.region.s3express." and "After creating a gateway endpoint, you can use Regional API endpoints and Zonal API endpoints to access Amazon S3 Express One Zone storage class objects and directory buckets."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-az-networking.html#s3-express-networking-vpc-gateway
- Gloss: Confirmed from the S3 side.

- Quote: "Note: For directory buckets, or S3 Express One Zone, the gateway endpoints for the data plane would be s3express-use2-az1.us-east-2.amazonaws.com and s3express-use2-az1.dualstack.us-east-2.amazonaws.com respectively."
- URL: https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html#gateway-endpoint-dns-record-ip-type
- Gloss: The zonal hostnames that the s3express gateway endpoint covers.

- Quote (us-east-1 row of the endpoint table): "| US East (N. Virginia) | us-east-1 | use1-az4 use1-az5 use1-az6 | s3express-control.us-east-1.amazonaws.com s3express-control.dualstack.us-east-1.amazonaws.com | s3express-use1-az4.us-east-1.amazonaws.com ... s3express-use1-az5.us-east-1.amazonaws.com ... s3express-use1-az6.us-east-1.amazonaws.com ... |"
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-az-networking.html#s3-express-endpoints-az
- Gloss: In us-east-1 directory buckets exist only in use1-az4, use1-az5, use1-az6.

---

## 7. HeadObject response headers

All quotes from https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html

- Quote: "Content-Length: Size of the body in bytes."
- Gloss: Object size (or range size if a Range header was sent).

- Quote: "Range: HeadObject returns only the metadata for an object. If the Range is satisfiable, only the ContentLength is affected in the response. If the Range is not satisfiable, S3 returns a 416 - Requested Range Not Satisfiable error."
- Gloss: Range on HEAD alters only Content-Length.

- Quote: "x-amz-storage-class: Provides storage class information of the object. Amazon S3 returns this header for all objects except for S3 Standard storage class objects. For more information, see Storage Classes. Directory buckets - Directory buckets only support EXPRESS_ONEZONE (the S3 Express One Zone storage class) in Availability Zones and ONEZONE_IA (the S3 One Zone-Infrequent Access storage class) in Dedicated Local Zones. Valid Values: STANDARD | REDUCED_REDUNDANCY | STANDARD_IA | ONEZONE_IA | INTELLIGENT_TIERING | GLACIER | DEEP_ARCHIVE | OUTPOSTS | GLACIER_IR | SNOW | EXPRESS_ONEZONE | FSX_OPENZFS | FSX_ONTAP | AWS_BACKUP_WARM | AWS_BACKUP_LOW_COST_WARM"
- Gloss: Absent for STANDARD objects; `EXPRESS_ONEZONE` for directory buckets in AZs.

- Quote: "x-amz-server-side-encryption: The server-side encryption algorithm used when you store this object in Amazon S3 or Amazon FSx. When accessing data stored in Amazon FSx file systems using S3 access points, the only valid server side encryption option is aws:fsx. Valid Values: AES256 | aws:fsx | aws:backup | aws:kms | aws:kms:dsse"
- Gloss: `AES256` means SSE-S3; `aws:kms` means SSE-KMS.

- Quote: "x-amz-checksum-crc64nvme: The Base64 encoded, 64-bit CRC64NVME checksum of the object. For more information, see Checking object integrity in the Amazon S3 User Guide."
- Gloss: Base64 of the 8-byte CRC.

- Quote: "x-amz-checksum-sha256: The Base64 encoded, 256-bit SHA256 digest of the object. This checksum is only present if the checksum was uploaded with the object. When you use an API operation on an object that was uploaded using multipart uploads, this value may not be a direct checksum value of the full object. Instead, it's a calculation based on the checksum values of each individual part. For more information about how checksums are calculated with multipart uploads, see Checking object integrity in the Amazon S3 User Guide."
- Gloss: For multipart objects the SHA256 header is a composite (checksum of part checksums), not a SHA256 of the bytes.

- Quote: "x-amz-checksum-type: The checksum type, which determines how part-level checksums are combined to create an object-level checksum for multipart objects. You can use this header response to verify that the checksum type that is received is the same checksum type that was specified in CreateMultipartUpload request. ... Valid Values: COMPOSITE | FULL_OBJECT"
- Gloss: Tells you which kind the checksum headers are.

- Quote: "Last-Modified: Date and time when the object was last modified."
- Gloss: HTTP date.

- Quote: "ETag: An entity tag (ETag) is an opaque identifier assigned by a web server to a specific version of a resource found at a URL."
- Gloss: Opaque; see question 3 for when it equals MD5.

- Quote: "x-amz-version-id: Version ID of the object. This functionality is not supported for directory buckets."
- Gloss: Only present on versioned general purpose buckets.

- Quote: "x-amz-mp-parts-count: The count of parts this object has. This value is only returned if you specify partNumber in your request and the object was uploaded as a multipart upload."
- Gloss: Part count is available via `?partNumber=1` on HEAD.

- Quote: "Encryption request headers, like x-amz-server-side-encryption, should not be sent for HEAD requests if your object uses server-side encryption with AWS Key Management Service (AWS KMS) keys (SSE-KMS), dual-layer server-side encryption with AWS KMS keys (DSSE-KMS), or server-side encryption with Amazon S3 managed encryption keys (SSE-S3). ... If you include this header in a HEAD request for an object that uses these types of keys, you'll get an HTTP 400 Bad Request error."
- Gloss: Don't send SSE headers on HEAD.

- Quote: "Directory buckets - For directory buckets, you must make requests for this API operation to the Zonal endpoint. These endpoints support virtual-hosted-style requests in the format https://amzn-s3-demo-bucket.s3express-zone-id.region-code.amazonaws.com/key-name. Path-style requests are not supported."
- Gloss: HEAD on a directory bucket must be virtual-hosted on the zonal endpoint.

---

## 8. Pricing sanity figures (US East, N. Virginia)

Primary numeric source: AWS Price List bulk API, offer `AmazonS3`, region `us-east-1`, `publicationDate` 2026-09-28T23:04:16Z, file https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json . Each quote is the SKU's `description` field.

**S3 Standard storage per GB-month**
- Quote: "$0.023 per GB - first 50 TB / month of storage used" (usagetype `TimedStorage-ByteHrs`, volumeType Standard, range 0-51200 GB); "$0.022 per GB - next 450 TB / month of storage used" (51200-512000); "$0.021 per GB - storage used / month over 500 TB" (512000-Inf)
- URL: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json
- Gloss: $0.023 / $0.022 / $0.021 per GB-month by tier.

**Requests**
- Quote: "$0.005 per 1,000 PUT, COPY, POST, or LIST requests" (usagetype `Requests-Tier1`, $0.0000050000 per request)
- Quote: "$0.004 per 10,000 GET and all other requests" (usagetype `Requests-Tier2`, $0.0000004000 per request)
- URL: same file
- Gloss: PUT/COPY/POST/LIST $0.005 per 1,000; GET $0.0004 per 1,000 (the feed words it per 10,000).

**Data transfer S3 to EC2 in the same Region**
- Quote (S3 pricing page, Data transfer tab): "You pay for all bandwidth into and out of Amazon S3, except for the following:" ... "Data transferred in from the internet." ... "Data transferred between S3 buckets in the same AWS Region." ... "Data transferred from an Amazon S3 bucket to any AWS service(s) within the same AWS Region as the S3 bucket" "(including to a different account in the same AWS Region)." ... "Data transferred out to Amazon CloudFront (CloudFront)."
- URL: https://aws.amazon.com/s3/pricing/
- Gloss: S3 to any AWS service (which includes EC2) in the same Region is excluded from S3 bandwidth charges. The page does not name EC2 separately.

- Quote (Price List, S3 offer): "$0.0 per GB for S3-DT-AWS Inbound" (External -> US East (N. Virginia), `DataTransfer-In-Bytes`)
- URL: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json
- Gloss: Inbound to S3 is $0.

- Quote (Price List, offer `AWSDataTransfer`, us-east-1, publicationDate 2026-09-16T13:22:08Z): "$0.010 per GB - regional data transfer - in/out/between EC2 AZs or using elastic IPs or ELB" (`DataTransfer-Regional-Bytes`, IntraRegion); and "$0.00 per GB - regional data transfer - in/out/between EC2 Azs or using elastic IPs or ELB" (`USE1-DataTransfer-xAZ-Out-Bytes` and `USE1-DataTransfer-xAZ-In-Bytes`, IntraRegion-xAZ-Out/In).
- URL: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.json
- Gloss: These are EC2 regional/cross-AZ transfer SKUs, not S3 ones; they are listed here because they are the only same-Region data-transfer prices in the feed. The S3 pricing page's exclusion list is the primary statement that S3-to-EC2 same-Region is not charged by S3.

- NOT FOUND: a sentence on the EC2 on-demand pricing page naming S3 explicitly as free same-Region transfer. The fetched page had a "Data Transfer within the same AWS Region" heading with no captured body text. URL checked: https://aws.amazon.com/ec2/pricing/on-demand/

**Data transfer out to the internet**
- Quote (AWSDataTransfer offer, US East (N. Virginia) -> External, `DataTransfer-Out-Bytes`): "$0.090 per GB - first 10 TB / month data transfer out beyond the global free tier" (0-10240 GB); "$0.085 per GB - next 40 TB / month data transfer out" (10240-51200); "$0.070 per GB - next 100 TB / month data transfer out" (51200-153600); "$0.050 per GB - greater than 150 TB / month data transfer out" (153600-Inf)
- URL: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.json
- Gloss: $0.09 / $0.085 / $0.07 / $0.05 per GB by monthly tier.

- Quote (S3 pricing page): "Data transferred out to the internet for the first 100GB per month, aggregated across all AWS Services and Regions" "(except China and GovCloud)" (listed as an exclusion) and "For Data Transfers exceeding 500 TB/Month, please contact us."
- URL: https://aws.amazon.com/s3/pricing/
- Gloss: 100 GB/month global free allowance; >500 TB is negotiated.

- Note: the S3 offer file itself carries `DataTransfer-Out-Bytes` US East (N. Virginia) -> External at "$0.0 per GB for S3-DT-AWS Outbound"; the billable internet-egress tiers are in the separate AWSDataTransfer offer quoted above.

**S3 Express One Zone storage and request prices**
- Quote (AmazonS3 offer, us-east-1): "$0.11 per GB-Mo of Storage in Express One Zone" (`TimedStorage-XZ-ByteHrs`); "$0.00113 per 1,000 PUT Requests/COPY/POST or LIST Requests to Express One Zone" (`Requests-XZ-Tier1`); "$0.00003 per 1,000 GET and All Other Requests to Express One Zone" (`Requests-XZ-Tier2`); "$0.0032 per GB for Object Upload in Express One Zone" (`Upload-XZ`); "$0.0006 per GB for Object Retrieval in Express One Zone" (`Retrieval-XZ`)
- URL: https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json
- Gloss: Storage $0.11/GB-month; PUT-class $0.00113 per 1,000; GET-class $0.00003 per 1,000; plus $0.0032/GB uploaded and $0.0006/GB retrieved.

**Does Express One Zone charge a per-GB "data upload" fee, and is there a 512 KB threshold?**
- Quote: "Posted on: Apr 10, 2025" and "reduced pricing for storage by 31%, PUT requests by 55%, and GET requests by 85%." (fragment) and the per-GB charges now apply "to all bytes rather than just portions of requests exceeding 512 kilobytes." (fragment) and "These pricing changes apply to S3 Express One Zone in all AWS Regions where the storage class is available."
- URL: https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-s3-express-one-zone-reduces-storage-request-prices/
- Gloss: Yes, there is a per-GB upload fee and a per-GB retrieval fee. Since 10 April 2025 they apply to every byte; the 512 KB threshold was removed, not introduced.

- Quote (AWS News Blog, 10 April 2025, by Channy Yun; figures as summarized from the post's table, US East N. Virginia): storage $0.16 -> $0.11 per GB-month; PUT $0.0025 -> $0.00113 per 1,000 (old price applied to requests up to 512 KB); GET $0.0002 -> $0.00003 per 1,000 (same 512 KB note); data upload $0.008 -> $0.0032 per GB; data retrieval $0.0015 -> $0.0006 per GB. Regions named: US East (N. Virginia), US East (Ohio), US West (Oregon), Asia Pacific (Mumbai), Asia Pacific (Tokyo), Europe (Ireland), Europe (Stockholm).
- URL: https://aws.amazon.com/blogs/aws/up-to-85-price-reductions-for-amazon-s3-express-one-zone/
- Gloss: The blog's before/after numbers match the Price List feed's current numbers exactly. (This item was returned by the fetch tool as a structured summary rather than a verbatim block; the dollar figures are as the tool reported them from the post.)

- Quote (S3 pricing page): "There are no data upload or data retrieval changes with the RenameObject API." and RenameObject is "priced the same as PUT, COPY, POST, LIST requests (per 1,000 requests) in S3 Express One Zone." (fragments; "changes" is the page's spelling)
- URL: https://aws.amazon.com/s3/pricing/
- Gloss: The page confirms per-GB upload/retrieval fees exist by exempting RenameObject from them.

---

## 9. Range GETs

- Quote: "Range: Downloads the specified byte range of an object. For more information about the HTTP Range header, see https://www.rfc-editor.org/rfc/rfc9110.html#name-range. Amazon S3 doesn't support retrieving multiple ranges of data per GET request."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
- Gloss: One byte range per GET; RFC 9110 syntax (`bytes=0-9`); multi-range requests are not supported.

- Quote (worked example on the same page): "The following request specifies the HTTP Range header to retrieve the first 10 bytes of an object. ... Note: Amazon S3 doesn't support retrieving multiple ranges of data per GET request." with request line "Range: bytes=0-9" and response headers "Accept-Ranges: bytes", "Content-Range: bytes 0-9/443", "Content-Length: 10".
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
- Gloss: Response carries `Content-Range: bytes <first>-<last>/<total>` and `Accept-Ranges: bytes`.

- Quote: "partNumber: Part number of the object being read. This is a positive integer between 1 and 10,000. Effectively performs a 'ranged' GET request for the part specified. Useful for downloading just a part of an object."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
- Gloss: `?partNumber=N` is an alternative to Range for multipart-uploaded objects.

- Quote: "Content-Range: The portion of the object returned in the response." and "accept-ranges: Indicates that a range of bytes was specified in the request."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
- Gloss: Header definitions.

- Quote: "For completed uploads, you can get an individual part's checksum by using the GetObject or HeadObject operations and specifying a part number or byte range that aligns with a single part."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- Gloss: A Range that exactly matches a part boundary returns that part's checksum.

---

## 10. CreateSession for directory buckets

All quotes from https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateSession.html unless noted.

**Token lifetime and per-bucket scope**
- Quote: "Temporary security credentials are scoped to the bucket and expire after 5 minutes. After the expiration time, any calls that you make with those credentials will fail. You must use IAM credentials again to make a CreateSession API request that generates a new set of temporary credentials for use. Temporary credentials cannot be extended or refreshed beyond the original specified interval."
- Gloss: 5-minute lifetime, scoped to one bucket, not renewable; call CreateSession again.

- Quote: "The AWS SDKs use the CreateSession API operation to request temporary credentials, and then automatically create and refresh tokens for you on your behalf every 5 minutes."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance.html#s3-express-optimizing-performance-session-authentication
- Gloss: SDKs refresh on a 5-minute cadence.

**Header name**
- Quote: "Instead, in your Zonal endpoint API requests, you sign your requests by applying the temporary security credentials of the session to the request headers and following the SigV4 protocol for authentication. You also apply the session token to the x-amz-s3session-token request header for authorization."
- Gloss: Sign with the session's access key/secret (SigV4) and add `x-amz-s3session-token: <SessionToken>`.

**Session modes**
- Quote: "x-amz-create-session-mode: Specifies the mode of the session that will be created, either ReadWrite or ReadOnly. If no session mode is specified, the default behavior attempts to create a session with the maximum allowable privilege. It will first attempt to create a ReadWrite session, and if that is not allowed by permissions, it will attempt to create a ReadOnly session. If neither session type is allowed, the request will return an Access Denied error. A ReadWrite session is capable of executing all the Zonal endpoint API operations on a directory bucket. A ReadOnly session is constrained to execute the following Zonal endpoint API operations: GetObject, HeadObject, ListObjectsV2, GetObjectAttributes, ListParts, and ListMultipartUploads. Valid Values: ReadOnly | ReadWrite"
- Gloss: Request header `x-amz-create-session-mode`; ReadOnly covers GET/HEAD/List; default tries ReadWrite then falls back.

- Quote: "In a policy, you can have the s3express:SessionMode condition key to control who can create a ReadWrite or ReadOnly session."
- Gloss: IAM condition key `s3express:SessionMode`.

**Request/response shape**
- Quote: "GET /?session HTTP/1.1 Host: Bucket.s3.amazonaws.com x-amz-create-session-mode: SessionMode ..." and the response body "<CreateSessionResult><Credentials><AccessKeyId>string</AccessKeyId><Expiration>timestamp</Expiration><SecretAccessKey>string</SecretAccessKey><SessionToken>string</SessionToken></Credentials></CreateSessionResult>"
- Gloss: It is `GET /?session` on the bucket's zonal hostname; returns four fields.

- Quote: "You must make requests for this API operation to the Zonal endpoint. These endpoints support virtual-hosted-style requests in the format https://bucket-name.s3express-zone-id.region-code.amazonaws.com. Path-style requests are not supported."
- Gloss: Zonal, virtual-hosted only.

- Quote (SessionCredentials type): "Expiration: Temporary security credentials expire after a specified interval. After temporary credentials expire, any calls that you make with those credentials will fail. So you must generate a new set of temporary credentials. Temporary credentials cannot be extended or refreshed beyond the original specified interval." and "Directory buckets - These session credentials are only supported for the authentication and authorization of Zonal endpoint API operations on directory buckets."
- URL: https://docs.aws.amazon.com/AmazonS3/latest/API/API_SessionCredentials.html
- Gloss: The Expiration timestamp is authoritative; credentials are usable only against zonal (object) operations.

**Operations that do not use the session**
- Quote: "CopyObject API operation - Unlike other Zonal endpoint API operations, the CopyObject API operation doesn't use the temporary security credentials returned from the CreateSession API operation for authentication and authorization." and "HeadBucket API operation - Unlike other Zonal endpoint API operations, the HeadBucket API operation doesn't use the temporary security credentials returned from the CreateSession API operation for authentication and authorization."
- Gloss: CopyObject and HeadBucket are signed with IAM credentials, not the session.

**Permission**
- Quote: "To obtain temporary security credentials, you must create a bucket policy or an IAM identity-based policy that grants s3express:CreateSession permission to the bucket."
- Gloss: The one IAM action needed on the bucket.

---

## Appendix: pages fetched

- https://aws.amazon.com/about-aws/whats-new/2026/04/amazon-s3-files
- https://aws.amazon.com/blogs/aws/launching-s3-files-making-s3-buckets-accessible-as-file-systems
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-quotas.html
- https://aws.amazon.com/s3/features/files/
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html
- https://aws.amazon.com/about-aws/whats-new/2025/12/amazon-s3-maximum-object-size-50-tb/
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html
- https://aws.amazon.com/about-aws/whats-new/2024/12/amazon-s3-default-data-integrity-protections
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_Object.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateMultipartUpload.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_HeadObject.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_CreateSession.html
- https://docs.aws.amazon.com/AmazonS3/latest/API/API_SessionCredentials.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-differences.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-optimizing-performance.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-using-multipart-upload.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-networking.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/directory-bucket-az-networking.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/privatelink-interface-endpoints.html
- https://docs.aws.amazon.com/vpc/latest/privatelink/vpc-endpoints-s3.html
- https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Route.html
- https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribePrefixLists.html
- https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-event-reference-record-contents.html
- https://aws.amazon.com/privatelink/pricing/
- https://aws.amazon.com/s3/pricing/
- https://aws.amazon.com/ec2/pricing/on-demand/
- https://aws.amazon.com/about-aws/whats-new/2025/04/amazon-s3-express-one-zone-reduces-storage-request-prices/
- https://aws.amazon.com/blogs/aws/up-to-85-price-reductions-for-amazon-s3-express-one-zone/
- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json
- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/us-east-1/index.json
- https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSDataTransfer/current/us-east-1/index.json

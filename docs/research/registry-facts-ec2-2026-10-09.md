# AWS EC2 / EBS fact verification for the LedgerMath design discussion

Date checked: 2026-10-09. Sources: only `docs.aws.amazon.com` pages (fetched live). Quotes are verbatim from the page text; field names are copied exactly as the API reference prints them (request-side names are UpperCamel, response-side names are lowerCamel; the API reference lists both where they differ).

Where a fact is not stated in the docs, the entry says **NOT FOUND IN DOCS**.

Method notes:
- The old IMDS categories URL `.../UserGuide/instancedata-data-categories.html` now returns `302` to the guide root. The categories table lives at `https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html#instancedata-data-categories`.
- The per-category instance-type spec pages (`ec2/latest/instancetypes/{gp,co,mo,so,ac,hpc,pg}.html`) were downloaded raw and their "Instance store specifications" tables parsed by family.

---

## 1. Instance Metadata Service (IMDS)

Source: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-metadata.html (section "Instance metadata categories"; columns are `Category | Description | Version when category was released`).

Base URI (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instancedata-data-retrieval.html): `http://169.254.169.254/latest/meta-data/` (IPv4), `http://[fd00:ec2::254]/latest/meta-data/` (IPv6); dynamic data at `http://169.254.169.254/latest/dynamic/`.

### 1a. Requested categories, exactly as listed

| Category (exact) | Description (verbatim) | Version |
|---|---|---|
| `placement/region` | "The AWS Region in which the instance is launched." | 2020-08-24 |
| `placement/availability-zone` | "The Availability Zone in which the instance launched." | 2008-02-01 |
| `placement/availability-zone-id` | "The static Availability Zone ID in which the instance is launched. The Availability Zone ID is consistent across accounts. However, it might be different from the Availability Zone, which can vary by account." | 2019-10-01 |
| `placement/group-name` | "The name of the placement group in which the instance is launched." | 2020-08-24 |
| `placement/host-id` | "The ID of the host on which the instance is launched. Applicable only to Dedicated Hosts." | 2020-08-24 |
| `placement/partition-number` | "The number of the partition in which the instance is launched." | 2020-08-24 |
| `instance-type` | "The type of instance." | 2007-08-29 |
| `ami-id` | "The AMI ID used to launch the instance." | 1.0 |
| `instance-id` | "The ID of this instance." | 1.0 |
| `instance-life-cycle` | "The purchasing option of this instance. For more information, see Amazon EC2 billing and purchasing options." | 2019-10-01 |
| `services/domain` | "The domain for AWS resources for the Region." | 2014-02-25 |
| `services/partition` | "The partition that the resource is in. For standard AWS Regions, the partition is `aws`. If you have resources in other partitions, the partition is `aws-partitionname`. For example, the partition for resources in the China (Beijing) Region is `aws-cn`." | 2015-10-20 |
| `hostname` | "If the EC2 instance is using IP-based naming (IPBN), this is the private IPv4 DNS hostname of the instance. If the EC2 instance is using Resource-based naming (RBN), this is the RBN. In cases where multiple network interfaces are present, this refers to the eth0 device (the device for which the device number is 0)." | 1.0 |
| `local-hostname` | same IPBN/RBN wording, eth0 | 2007-01-19 |
| `public-hostname` | "The instance's public DNS (IPv4). This category is only returned if the enableDnsHostnames attribute is set to true. ... If the instance only has a public-IPv6 address and no public-IPv4 address, this item is not set and results in an HTTP 404 response." | 2007-01-19 |
| `mac` | "The instance's media access control (MAC) address. In cases where multiple network interfaces are present, this refers to the eth0 device (the device for which the device number is 0)." | 2011-01-01 |
| `network/interfaces/macs/{mac}/vpc-id` | "The ID of the VPC in which the interface resides." | 2011-01-01 |
| `network/interfaces/macs/{mac}/subnet-id` | "The ID of the subnet in which the interface resides." | 2011-01-01 |
| `network/interfaces/macs/{mac}/security-group-ids` | "The IDs of the security groups to which the network interface belongs." | 2011-01-01 |
| `network/interfaces/macs/{mac}/security-groups` | "Security groups to which the network interface belongs." | 2011-01-01 |
| `network/interfaces/macs/{mac}/device-number` | "The unique device number associated with that interface. ... corresponds to the DeviceIndex and device-index fields" | 2011-01-01 |
| `network/interfaces/macs/{mac}/interface-id` | "The ID of the network interface." | 2011-01-01 |
| `network/interfaces/macs/{mac}/network-card` | "The index of the network card. Some instance types support multiple network cards." | 2020-11-01 |
| `system` | "The underlying virtualization type (hypervisor) of the instance." | 2022-09-24 |
| `kernel-id` / `ramdisk-id` | "The ID of the kernel launched with this instance, if applicable." / "The ID of the RAM disk specified at launch time, if applicable." | 2008-02-01 / 2007-10-10 |
| `block-device-mapping/ephemeralN` | "The virtual devices for any non-NVMe instance store volumes. ..." | 2007-12-15 |
| `tags/instance` | "The instance tags associated with the instance. Only available if you explicitly allow access to tags in instance metadata." | 2021-03-23 |

Other per-MAC paths in the table: `ipv4-associations/{public-ip}`, `ipv6s`, `ipv6-prefix`, `local-hostname`, `local-ipv4s`, `mac`, `owner-id`, `public-hostname`, `public-ipv4s`, `subnet-ipv4-cidr-block`, `subnet-ipv6-cidr-blocks`, `vpc-ipv4-cidr-block`, `vpc-ipv4-cidr-blocks`, `vpc-ipv6-cidr-blocks`.

Note on category availability (verbatim): "With Nitro-based instances, you can retrieve instance metadata only for the categories that were available at launch."

**`instance-life-cycle` possible values: NOT FOUND IN DOCS.** The table gives only the description above; no enumerated values appear on the categories page, the purchasing-options page, or the Spot pages that were checked.

### 1b. Dynamic data: instance identity document

Source (fields): https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-identity-documents.html
Source (retrieval + example): https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/retrieve-iid.html

Path: `http://169.254.169.254/latest/dynamic/instance-identity/document` (IMDSv2: `TOKEN=\`curl -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 21600"\` && curl -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/dynamic/instance-identity/document`). Sibling dynamic categories: `instance-identity/pkcs7`, `instance-identity/signature`, plus listed `rsa2048`, `dsa2048`, and `fws/instance-monitoring`.

"The instance identity document is generated when the instance is stopped and started, restarted, or launched."

Every field (verbatim descriptions):

| Field | Description |
|---|---|
| `accountId` | "The ID of the AWS account that launched the instance." |
| `architecture` | "The architecture of the AMI used to launch the instance (i386 \| x86_64 \| arm64)." |
| `availabilityZone` | "The name of the Availability Zone in which the instance is running. ... Keep in mind that Availability Zone names might differ across AWS accounts." |
| `billingProducts` | "The billing products of the instance." |
| `devpayProductCodes` | "Deprecated." |
| `imageId` | "The ID of the AMI used to launch the instance." |
| `instanceId` | "The ID of the instance." |
| `instanceType` | "The instance type of the instance." |
| `kernelId` | "The ID of the kernel associated with the instance, if applicable." |
| `marketplaceProductCodes` | "The AWS Marketplace product code of the AMI used to launch the instance." |
| `pendingTime` | "The date and time that the instance was launched." |
| `privateIp` | "The private IP address of the instance. For IPv4-only and dual-stack instances, this contains the IPv4 address. For IPv6-only instances, this contains the IPv6 address." |
| `ramdiskId` | "The ID of the RAM disk associated with the instance, if applicable." |
| `region` | "The Region in which the instance is running." |
| `version` | "The version of the instance identity document format." |

Example output on the retrieval page: `"version" : "2017-09-30"`, `"pendingTime" : "2016-11-19T16:32:11Z"`, `"billingProducts" : null`, `"marketplaceProductCodes" : [ "1abc2defghijklm3nopqrs4tu" ]`, `"kernelId" : null`, `"ramdiskId" : null`. There is no availability-zone-id in the identity document.

### 1c. Does IMDS expose tenancy, CPU options, launch time?

- **Tenancy: NOT FOUND IN DOCS.** No category in the table mentions tenancy. The only related item is `placement/host-id` — "Applicable only to Dedicated Hosts." Nothing distinguishes `default` from `dedicated` tenancy.
- **CPU options (core count / threads per core): NOT FOUND IN DOCS.** No category in the table mentions CPU, cores, or threads.
- **Launch time:** no `meta-data` category. The only launch timestamp is `pendingTime` in the identity document ("The date and time that the instance was launched."). Note the API-side caveat in section 2: `launchTime` is "the time that the instance was last launched".

---

## 2. `DescribeInstances` response — `Instance` data type

Source: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Instance.html (response names are lowerCamel on this page).

| Field | Type | Verbatim description / valid values |
|---|---|---|
| `cpuOptions` | CpuOptions | "The CPU options for the instance." |
| `placement` | Placement | "The location where the instance launched, if applicable." |
| `launchTime` | Timestamp | "The time that the instance was last launched. To determine the time that instance was first launched, see the attachment time for the primary network interface." |
| `imageId` | String | "The ID of the AMI used to launch the instance." |
| `instanceId` | String | "The ID of the instance." |
| `hypervisor` | String | "The hypervisor type of the instance. The value `xen` is used for both Xen and Nitro hypervisors." Valid: `ovm \| xen` |
| `bootMode` | String | "The boot mode that was specified by the AMI. If the value is `uefi-preferred`, the AMI supports both UEFI and Legacy BIOS. The `currentInstanceBootMode` parameter is the boot mode that is used to boot the instance at launch or start." Valid: `legacy-bios \| uefi \| uefi-preferred` |
| `currentInstanceBootMode` | String | "The boot mode that is used to boot the instance at launch or start." Valid: `legacy-bios \| uefi` |
| `instanceLifecycle` | String | "Indicates whether this is a Spot Instance or a Scheduled Instance." Valid: `spot \| scheduled \| capacity-block \| interruptible-capacity-reservation` |
| `metadataOptions` | InstanceMetadataOptionsResponse | "The metadata options for the instance." |
| `architecture` | String | "The architecture of the image." Valid: `i386 \| x86_64 \| arm64 \| x86_64_mac \| arm64_mac` |
| `platformDetails` | String | "The platform details value for the instance. For more information, see AMI billing information fields" |
| `usageOperation` | String | "The usage operation value for the instance." (+ `usageOperationUpdateTime`, Timestamp) |
| `virtualizationType` | String | "The virtualization type of the instance." Valid: `hvm \| paravirtual` |
| `ebsOptimized` | Boolean | "Indicates whether the instance is optimized for Amazon EBS I/O. ... Additional usage charges apply when using an EBS Optimized instance." |
| `enaSupport` | Boolean | "Specifies whether enhanced networking with ENA is enabled." |
| `networkPerformanceOptions` | InstanceNetworkPerformanceOptions | "Contains settings for the network performance options for your instance." |
| `tpmSupport` | String | "If the instance is configured for NitroTPM support, the value is `v2.0`." |
| `enclaveOptions` / `hibernationOptions` / `maintenanceOptions` | objects | "Indicates whether the instance is enabled for AWS Nitro Enclaves." / "...for hibernation." / "Provides information on the recovery and maintenance options of your instance." |
| `rootDeviceType` | String | Valid: `ebs \| instance-store` |
| `spotInstanceRequestId`, `capacityReservationId`, `capacityBlockId`, `instanceState`, `stateReason`, `clientToken`, `amiLaunchIndex`, `kernelId`, `ramdiskId`, `subnetId`, `vpcId`, `platform` (Valid: `windows`) | | also present |

`CpuOptions` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CpuOptions.html): `amdSevSnp` String Valid `enabled | disabled`; `coreCount` Integer "The number of CPU cores for the instance."; `threadsPerCore` Integer "The number of threads per CPU core."; `nestedVirtualization` String Valid `enabled | disabled`.

`Placement` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Placement.html) — response names: `affinity`, `availabilityZone`, `availabilityZoneId`, `groupId`, `groupName`, `hostId`, `hostResourceGroupArn`, `partitionNumber`, `spreadDomain` ("Reserved for future use."), `tenancy` ("The tenancy of the instance. An instance with a tenancy of `dedicated` runs on single-tenant hardware." Valid: `default | dedicated | host`). `partitionNumber`: "Valid only if the placement group strategy is set to `partition`."

`InstanceMetadataOptionsResponse` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceMetadataOptionsResponse.html): `httpEndpoint` (`disabled | enabled`), `httpProtocolIpv6` (`disabled | enabled`), `httpPutResponseHopLimit` ("Integers from `1` to `64`"), `httpTokens` (`optional | required`), `instanceMetadataTags` (`disabled | enabled`), `state` (`pending | applied`).

`InstanceMaintenanceOptions` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceMaintenanceOptions.html): `autoRecovery` (`disabled | default`), `rebootMigration` (`disabled | default`): "`default` - Amazon EC2 attempts to migrate the instance to new hardware (reboot migration). ... `disabled` - Amazon EC2 keeps the instance on the same hardware (in-place reboot)."

### `DescribeInstanceCreditSpecifications`
https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DescribeInstanceCreditSpecifications.html — "Describes the credit option for CPU usage of the specified burstable performance instances. The credit options are `standard` and `unlimited`." Request: `InstanceId.N` (max 1000), `Filter.N` (`instance-id`), `MaxResults`, `NextToken`, `DryRun`. Response: `instanceCreditSpecificationSet` of `InstanceCreditSpecification` items with `cpuCredits` and `instanceId` (sample: `<cpuCredits>unlimited</cpuCredits>`). "If you specify an instance ID that is not a burstable performance instance, Amazon EC2 returns the `standard` credit option."

### `ModifyInstanceCreditSpecification`
https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ModifyInstanceCreditSpecification.html — "Modifies the credit option for CPU usage on a running or stopped burstable performance instance. The credit options are `standard` and `unlimited`." Request: `InstanceCreditSpecification.N` (Required: Yes; items `InstanceCreditSpecification.1.InstanceId`, `InstanceCreditSpecification.1.CpuCredits=unlimited`), `ClientToken`, `DryRun`. Response: `successfulInstanceCreditSpecificationSet`, `unsuccessfulInstanceCreditSpecificationSet`.

---

## 3. `RunInstances` request parameters

Source: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RunInstances.html (plus the linked data types).

### 3a. Availability Zone ID
- The parameter is **`Placement.AvailabilityZoneId`** (a field of the `Placement` object). There is **no top-level `AvailabilityZoneId`** parameter on `RunInstances`; the only occurrences of "AvailabilityZone" on the page are `Placement.AvailabilityZone=us-east-1d` (Example) and `Placement.AvailabilityZoneId=use2-az1` (Example 15).
- `Placement.AvailabilityZoneId` (API_Placement): "The ID of the Availability Zone of the instance. On input, you can specify `AvailabilityZone` or `AvailabilityZoneId`, but not both. If you specify neither one, Amazon EC2 automatically selects an Availability Zone for you. This parameter is not supported for CreateFleet."
- `EbsBlockDevice.AvailabilityZoneId` exists but: "This parameter is not supported when using CreateFleet, CreateImage, DescribeImages, RequestSpotFleet, RequestSpotInstances, and RunInstances." (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_EbsBlockDevice.html)
- Example 15 request line (verbatim): `&Placement.AvailabilityZoneId=use2-az1`; response shows `<availabilityZone>us-east-2a</availabilityZone>` and `<availabilityZoneId>use2-az1</availabilityZoneId>`.

### 3b. Other parameters (exact names, verbatim descriptions)
- `Placement` — "The placement for the instance." Type `Placement`. Sub-fields (request names): `Placement.Affinity` ("The affinity setting for the instance on the Dedicated Host."), `Placement.AvailabilityZone`, `Placement.AvailabilityZoneId`, `Placement.GroupId`, `Placement.GroupName` ("On input, you can specify `GroupId` or `GroupName`, but not both."), `Placement.HostId` ("The ID of the Dedicated Host on which the instance resides."), `Placement.HostResourceGroupArn` ("The ARN of the host resource group in which to launch the instances. On input, if you specify this parameter, either omit the Tenancy parameter or set it to `host`."), `Placement.PartitionNumber`, `Placement.Tenancy` (Valid `default | dedicated | host`; "The `host` tenancy is not supported for ImportInstance or for T3 instances that are configured for the `unlimited` CPU credit option.").
- `CpuOptions` — Type `CpuOptionsRequest` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CpuOptionsRequest.html): "Both the core count and threads per core must be specified in the request." Fields: `CoreCount` (Integer), `ThreadsPerCore` (Integer; "To disable multithreading for the instance, specify a value of `1`. Otherwise, specify the default value of `2`."), `AmdSevSnp` (`enabled | disabled`; "AMD SEV-SNP is supported with M6a, R6a, and C6a instance types only."), `NestedVirtualization` (`enabled | disabled`; "supported only on 8th generation Intel-based instance types (c8i, m8i, r8i, and their flex variants)").
- `CreditSpecification` — Type `CreditSpecificationRequest`, field `CpuCredits` (Required: Yes; "Valid values: `standard` | `unlimited`"). RunInstances text: "Default: `standard` (T2 instances) or `unlimited` (T3/T3a/T4g instances). For T3 instances with `host` tenancy, only `standard` is supported."
- `InstanceMarketOptions` — Type `InstanceMarketOptionsRequest`: `MarketType` Valid `spot | capacity-block | interruptible-capacity-reservation | on-demand`; `SpotOptions` (SpotMarketOptions).
- `MetadataOptions` — Type `InstanceMetadataOptionsRequest`: `HttpEndpoint` (`disabled | enabled`, Default `enabled`), `HttpProtocolIpv6` (Default `disabled`), `HttpPutResponseHopLimit` ("Integers from 1 to 64"), `HttpTokens` (`optional | required`; default depends on AMI `ImdsSupport` and account default), `InstanceMetadataTags` (Default `disabled`).
- `HibernationOptions` — `HibernationOptionsRequest.Configured` Boolean, Default `false`. "You can't enable hibernation and AWS Nitro Enclaves on the same instance."
- `EnclaveOptions` — `EnclaveOptionsRequest.Enabled` Boolean.
- `MaintenanceOptions` — Type `InstanceMaintenanceOptionsRequest`: **only** `AutoRecovery` (`disabled | default`). `RebootMigration` is not a launch parameter; it is set with `ModifyInstanceMaintenanceOptions` (`RebootMigration`, Valid `disabled | default`) — https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ModifyInstanceMaintenanceOptions.html
- `PrivateDnsNameOptions` — "The default values are inherited from the subnet." Fields: `HostnameType` (`ip-name | resource-name`), `EnableResourceNameDnsARecord`, `EnableResourceNameDnsAAAARecord`.
- `DisableApiTermination` — Boolean. "The default is `false` ... You can enable termination protection when you launch an instance, while the instance is running, or while the instance is stopped."
- `DisableApiStop` — Boolean. "Indicates whether an instance is enabled for stop protection."
- `EbsOptimized` — Boolean, "Default: `false`". "Additional usage charges apply when using an EBS-optimized instance."
- `NetworkPerformanceOptions` — Type `InstanceNetworkPerformanceOptionsRequest`, field `BandwidthWeighting` Valid `default | vpc-1 | ebs-1`: "`default` This option uses the standard bandwidth configuration for your instance type. `vpc-1` This option boosts your networking baseline bandwidth and reduces your EBS baseline bandwidth. `ebs-1` This option boosts your EBS baseline bandwidth and reduces your networking baseline bandwidth." Response type adds: "you can boost your baseline bandwidth for either networking or EBS by up to 25%. The total available baseline bandwidth for your instance remains the same."
- `SubnetId` — "The ID of the subnet to launch the instance into. If you specify a network interface, you must specify any subnets as part of the network interface instead of using this parameter."
- `BlockDeviceMapping.N` — "The block device mapping, which defines the EBS volumes and instance store volumes to attach to the instance at launch." Items (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_BlockDeviceMapping.html): `DeviceName`, `Ebs` (EbsBlockDevice), `NoDevice`, `VirtualName` ("NVMe instance store volumes are automatically enumerated and assigned a device name. Including them in your block device mapping has no effect.").

### 3c. Root/EBS volume settings in `EbsBlockDevice` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_EbsBlockDevice.html)
- `VolumeType` Valid `standard | io1 | io2 | gp2 | sc1 | st1 | gp3`.
- `VolumeSize` (GiB): "`gp2`: 1 - 16,384 GiB; `gp3`: 1 - 65,536 GiB; `io1`: 4 - 16,384 GiB; `io2`: 4 - 65,536 GiB; `st1` and `sc1`: 125 - 16,384 GiB; `standard`: 1 - 1024 GiB". "If you specify a snapshot, the default is the snapshot size."
- `Iops`: "`gp3`: 3,000 - 80,000 IOPS; `io1`: 100 - 64,000 IOPS; `io2`: 100 - 256,000 IOPS ... For `io2` volumes, you can achieve up to 256,000 IOPS on instances built on the Nitro System. On other instances, you can achieve performance up to 32,000 IOPS. This parameter is required for `io1` and `io2` volumes. The default for `gp3` volumes is 3,000 IOPS."
- `Throughput`: "The throughput that the volume supports, in MiB/s. This parameter is valid only for `gp3` volumes. Valid Range: Minimum value of 125. Maximum value of 2,000."
- `Encrypted` Boolean; `KmsKeyId` ("only supported on `BlockDeviceMapping` objects called by RunInstances, RequestSpotFleet, and RequestSpotInstances"); `DeleteOnTermination` Boolean; `SnapshotId`; `VolumeInitializationRate` ("Valid range: 100 - 300 MiB/s"; "supported only for volumes created from snapshots"); `EbsCardIndex`.
- User-guide limitation (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-block-device-mapping.html): "For the root volume, you can only modify the following: volume size, volume type, and the Delete on Termination flag."

---

## 4. `DescribeInstanceTypes` — `InstanceTypeInfo`

Source: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceTypeInfo.html (response names lowerCamel).

Confirmed fields: `vCpuInfo`, `memoryInfo`, `processorInfo`, `instanceStorageInfo`, `instanceStorageSupported` (Boolean), `ebsInfo`, `networkInfo`, `bareMetal` (Boolean: "Indicates whether the instance is a bare metal instance type."), `hypervisor` (Valid `nitro | xen`), `burstablePerformanceSupported` (Boolean), `dedicatedHostsSupported` (Boolean), `SupportedBootModes.N` (Valid `legacy-bios | uefi`), `nitroEnclavesSupport` (Valid `unsupported | supported`), `nitroTpmSupport` (Valid `unsupported | supported`), `nitroTpmInfo`, `currentGeneration`, `freeTierEligible`, `hibernationSupported`, `autoRecoverySupported`, `phcSupport` (`unsupported | supported`), `rebootMigrationSupport` (`unsupported | supported`), `placementGroupInfo`, `SupportedUsageClasses.N` (`spot | on-demand | capacity-block`), `SupportedRootDeviceTypes.N` (`ebs | instance-store`), `SupportedVirtualizationTypes.N` (`hvm | paravirtual`), `supportedInRegion`, `gpuInfo`, `fpgaInfo`, `neuronInfo`, `mediaAcceleratorInfo`, `inferenceAcceleratorInfo`.

- `VCpuInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_VCpuInfo.html): `defaultVCpus`, `defaultCores`, `defaultThreadsPerCore` (Integers), `ValidCores.N`, `ValidThreadsPerCore.N` (arrays of integers).
- `MemoryInfo`: `sizeInMiB` Long "The size of the memory, in MiB."
- `ProcessorInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ProcessorInfo.html): `manufacturer` String; `SupportedArchitectures.N` Valid `i386 | x86_64 | arm64 | x86_64_mac | arm64_mac`; `sustainedClockSpeedInGhz` Double "The speed of the processor, in GHz."; `SupportedFeatures.N` Valid `amd-sev-snp | nested-virtualization`.
- `InstanceStorageInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceStorageInfo.html): `totalSizeInGB` Long "The total size of the disks, in GB."; `Disks.N` of `DiskInfo` (`count` Integer, `sizeInGB` Long, `type` Valid `hdd | ssd`); `nvmeSupport` Valid `unsupported | supported | required`; `encryptionSupport` "Indicates whether data is encrypted at rest." Valid `unsupported | required`.
- `EbsInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_EbsInfo.html): `ebsOptimizedInfo`; `ebsOptimizedSupport` Valid `unsupported | supported | default`; `encryptionSupport` `unsupported | supported`; `nvmeSupport` `unsupported | supported | required`; also `attachmentLimitType` (`shared | dedicated`), `maximumEbsAttachments`, `maximumEbsCards`, `EbsCardSet.N`.
- `EbsOptimizedInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_EbsOptimizedInfo.html): `baselineBandwidthInMbps` Integer, `baselineIops` Integer, `baselineThroughputInMBps` Double, `maximumBandwidthInMbps` Integer, `maximumIops` Integer, `maximumThroughputInMBps` Double.
- `NetworkInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_NetworkInfo.html): `networkPerformance` String "The network performance."; `enaSupport` Valid `unsupported | supported | required`; `efaSupported` Boolean; `efaInfo`; `BandwidthWeightings.N` Valid `default | vpc-1 | ebs-1`; `maximumNetworkInterfaces` Integer; `maximumNetworkCards`; `defaultNetworkCardIndex`; `NetworkCards.N`; `ipv4AddressesPerInterface`; `ipv6AddressesPerInterface`; `ipv6Supported`; `encryptionInTransitSupported`; `enaSrdSupported`; `flexibleEnaQueuesSupport` (`unsupported | supported`); `connectionTrackingConfiguration`; `secondaryNetworkSupported`; `maximumSecondaryNetworkInterfaces`; `ipv4AddressesPerSecondaryInterface`.

Example from the instance-store page (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-volumes.html) for `r8id.32xlarge`: `{"TotalSizeInGB": 7600, "Disks": [{"SizeInGB": 3800, "Count": 2, "Type": "ssd"}], "NvmeSupport": "required", "EncryptionSupport": "required"}`.

---

## 5. Instance store volumes on NVMe

### 5a. Which families
- Naming (https://docs.aws.amazon.com/ec2/latest/instancetypes/instance-type-names.html): option letter "**d** – Instance store volumes".
- Limits page (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-volumes.html): "Some instance types, such as C8i, M8i, and R8i, do not support instance store volumes, while other instance types, such as C8id, M8id, and R8id, do support instance store volumes." "For instance types with NVMe instance store volumes, all of the supported instance store volumes are automatically attached to the instance at launch. For instance types with non-NVMe instance store volumes, such as C1, C3, M1, M2, M3, R3, D2, H1, I2, X1, and X1e, you must manually specify the block device mappings ..."
- Non-NVMe SSD (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ssd-instance-store.html): "The following instances support instance store volumes that use non-NVMe SSDs ...: C3, I2, M3, R3, and X1."
- Per-family "Instance store type" column, parsed from the Instance Types Guide spec tables (column headings: `Instance type | Instance store volumes | Instance store type | 100% random read IOPS / Write IOPS | Needs initialization 1 | TRIM support 2`; intro: "aggregated IOPS performance with 4,096 byte block size at queue depth saturation"):
  - General purpose (https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html#gp_instance-store) — NVMe SSD: M5ad, M5d, M5dn, M6gd, M6id, M6idn, M7gd, M8gd, M8id, M8idn, M8idb, M9gd, Mac-m4, Mac-m4pro.
  - Compute optimized (co.html#co_instance-store) — NVMe SSD: C5ad, C5d, C6gd, C6id, C7gd, C8gd, C8id, C9gd.
  - Memory optimized (mo.html#mo_instance-store) — NVMe SSD: R5ad, R5d, R5dn, R6gd, R6id, R6idn, R7gd, R8gd, R8id, R8idn, R8idb, R9gd, X2gd, X2idn, X2iedn, X8aedz, z1d; non-NVMe "SSD": X1, X1e.
  - Storage optimized (so.html#so_instance-store) — NVMe SSD: I3, I3en, I4g, I4i, I7i, I7ie, I8g, I8ge, Im4gn, Is4gen; "NVMe HDD": D3, D3en; "HDD": D2, H1.
  - Accelerated (ac.html#ac_instance-store) — NVMe SSD: DL1, F2, G4ad, G4dn, G5, G6, G6e, G6f, Gr6, Gr6f, G7, G7e, P4d, P4de, P5, P5e, P5en, P6-B200, P6-B300, P6e-GB200, Trn1, Trn1n, Trn2, Trn2u.
  - HPC (hpc.html#hpc_instance-store) — NVMe SSD: Hpc6id.
  - Previous generation (pg.html#pg_instance-store) — HDD: C1, M1, M2; SSD: C3, I2, M3, R3; NVMe SSD: P3dn.
  - Footnotes (verbatim): "1 Volumes attached to certain instances suffer a first-write penalty unless initialized. For more information, see Optimize disk performance for instance store volumes." "2 For more information, see Instance store volume TRIM support." In the storage-optimized table the "Needs initialization" check appears on D2 and H1 rows (HDD), and "TRIM support ✓ Yes" on all NVMe rows.

### 5b. Model string / serial number as seen by the guest
- EBS (https://docs.aws.amazon.com/ebs/latest/userguide/identify-nvme-ebs-device.html), verbatim `nvme id-ctrl -V /dev/nvme0n1` output: `vid : 0x1d0f`, `ssvid : 0x1d0f`, `sn : vol01234567890abcdef`, `mn : Amazon Elastic Block Store`. "NVMe EBS volumes have the EBS volume ID set as the serial number in the device identification. Use the `lsblk -o +SERIAL` command to list the serial number." (The serial is the volume ID with the hyphen removed, per the examples `vol01234567890abcdef` / `vol06afc3f8715b7a597`.)
- Instance store model string: the docs show it via `sudo nvme list` (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-block-device-mapping.html#nvme-instance-store): "The text in the Model column indicates whether the volume is an EBS volume or an instance store volume." Sample rows: `/dev/nvme0n1 vol06afc3f8715b7a597 Amazon Elastic Block Store 1`, `/dev/nvme1n1 AWS2C1436F5159EB6614 Amazon EC2 NVMe Instance Storage 1`, `/dev/nvme2n1 AWSB1F4FF0C0A6C281EA Amazon EC2 NVMe Instance Storage 1`. The EKS page (https://docs.aws.amazon.com/eks/latest/userguide/lis-csi.html) states: "`Amazon Elastic Block Store` = EBS volume; `Amazon EC2 NVMe Instance Storage` = local instance storage". An explicit `nvme id-ctrl` `mn`/`sn` listing for an instance store device, and a documented serial-number format for instance store: **NOT FOUND IN DOCS** (the sample serials begin with `AWS` followed by 17 hex characters, but no page describes the format).
- The EKS page also documents that newly launched instances report changed Identify fields for local storage only: "Bit 3 of OACS: changed from 0 to 1; Bit 8 of OAES: changed from 0 to 1; NN: changed from 1 to a value <= 256; TNVMCAP: changed from 0 to the actual size of the local storage; NVMCAP: ...; NGUID: changed from all zeros to a valid NGUID."

### 5c. Vendor-specific bytes holding the block-device-mapping name (EBS)
Verbatim: "the block device mappings that are specified ... during `AttachVolume` or `RunInstances` API calls are captured in the vendor-specific data field of the NVMe controller identification." And: "The device name is available through the NVMe controller vendor-specific extension (bytes 384:4095 of the controller identification)". Example dump line: `0000: 2f 64 65 76 2f 73 64 6a 20 20 20 20 20 20 20 20 "sda..."` (volume attached at launch, name without `/dev/`) vs `"/dev/sdf..."` for a volume attached after launch. Tools: "`sudo ebsnvme-id /dev/nvme0n1 -u`" (Amazon Linux/FreeBSD) and "`sudo nvme id-ctrl -V /dev/nvme0n1`" ("You might need to include the `--vendor-specific` command option."). Sample `ebsnvme-id` output: `Volume ID: vol-01324f611e2463981` / `sda`. Windows: `ebsnvme-id.exe` in `C:\ProgramData\Amazon\Tools`.

### 5d. Initialization / TRIM / pre-warming
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/disk-performance.html: "the first write to any location on some instance store volumes performs more slowly than subsequent writes." "**Instance types with direct-attached solid state drives (SSD) and TRIM support provide maximum performance at launch time, without initialization.**" The `dd if=/dev/zero of=/dev/sdb bs=1M` initialization applies to "the `m1.large`, `m1.xlarge`, `c1.xlarge`, `m2.xlarge`, `m2.2xlarge`, and `m2.4xlarge` instance types".
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ssd-instance-store.html: "Instance store volumes that support TRIM are fully trimmed before they are allocated to your instance. These volumes are not formatted with a file system when an instance launches, so you must format them before they can be mounted and used. For faster access to these volumes, you should skip the TRIM operation when you format them." "As you fill the SSD-based instance store volumes for your instance, the number of write IOPS that you can achieve decreases." "we recommend that you leave 10 percent of the volume unpartitioned so that the SSD controller can use it for over-provisioning." Writes "not in multiples of 4,096 bytes or not aligned to a 4,096-byte boundary" cause "dramatically reduced I/O performance". "On Linux instances, use the `fstrim` command to enable periodic TRIM." "The NVMe volumes are compliant with the NVMe 1.0e specification."

### 5e. Data lifetime (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-lifetime.html)
"The data on an instance store volume persists even if the instance is rebooted. However, the data does not persist if the instance is stopped, hibernated, or terminated. When the instance is stopped, hibernated, or terminated, every block of the instance store volume is cryptographically erased." Table: rebooted → "The data persists"; stopped / hibernated / terminated → "The data does not persist"; "The instance type is changed" → "The data does not persist *"; AWS "Instance reboot" and "System reboot" → "The data persists"; "Instance retirement" → does not persist; "The underlying disk fails" → "The data on the failed disk does not persist"; "Power failure" → "The data persists upon reboot". "You can't attach instance store volumes after launch."

### 5f. Encryption at rest
https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/data-protection.html: "The data on NVMe instance store volumes is encrypted using an XTS-AES-256 cipher, implemented on a hardware module on the instance. The keys ... are per-customer, and per volume. ... The encryption keys are destroyed when the instance is stopped or terminated and cannot be recovered. You cannot disable this encryption and you cannot provide your own encryption key." "The data on HDD instance store volumes on H1, D3, and D3en instances is encrypted using XTS-AES-256 and one-time keys." (ssd-instance-store.html adds: "The encryption keys are generated using the hardware module and are unique to each NVMe instance storage device.")

---

## 6. EBS volumes

### 6a. `DescribeVolumes` → `Volume` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Volume.html)
Fields: `volumeId`, `volumeArn`, `volumeType` (Valid `standard | io1 | io2 | gp2 | sc1 | st1 | gp3`), `size` ("in GiBs"), `iops` ("For `gp3`, `io1`, and `io2` volumes, this represents the number of IOPS that are provisioned for the volume. For `gp2` volumes, this represents the baseline performance..."), `throughput` ("in MiB/s"), `encrypted`, `kmsKeyId`, `multiAttachEnabled`, `availabilityZone`, `availabilityZoneId`, `snapshotId`, `sourceVolumeId`, `createTime`, `fastRestored`, `volumeInitializationRate` ("If no volume initialization rate was specified, the value is `null`."), `sseType` (`sse-ebs | sse-kms | none`), `operator`, `outpostArn`, `ownerId`, `TagSet.N`, `AttachmentSet.N`.
State field: **`status`** (not `State`) — Valid `creating | available | in-use | deleting | deleted | error`.
`VolumeAttachment` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_VolumeAttachment.html): `device` ("The device name."), `instanceId`, `status` (Valid `attaching | attached | detaching | detached | busy`), `attachTime`, `deleteOnTermination`, `volumeId`, `ebsCardIndex`, `associatedResource`, `instanceOwningService`.

### 6b. Volume types (https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html)
SSD table: gp3 — Volume size "1 GiB - 64 TiB", Max IOPS "80,000 (25.6 KiB I/O)", Max throughput "2,000 MiB/s"; gp2 — "1 GiB - 16 TiB", "16,000 (16 KiB I/O)", "250 MiB/s"; io2 Block Express — "4 GiB - 64 TiB", "256,000 (16 KiB I/O)", "4,000 MiB/s", durability "99.999%"; io1 — "4 GiB - 16 TiB", "64,000 (16 KiB I/O)", "1,000 MiB/s". Footnote 3: "Nitro-based instances support volumes provisioned with up to 256,000 IOPS. Other instance types can be attached to volumes provisioned with up to 64,000 IOPS, but can achieve up to 32,000 IOPS." Footnote 4: "Represents the required I/O size to reach maximum IOPS within the volume's throughput limit." Multi-attach: gp2/gp3 "Not supported", io1/io2 "Supported".
HDD table: st1 — "125 GiB - 16 TiB", Max IOPS "(1 MiB I/O)" 500, Max throughput "500 MiB/s"; sc1 — 250 / "250 MiB/s"; Boot volume "Not supported".
Magnetic `standard`: "1 GiB-1 TiB", "Max IOPS per volume 40–200", "Max throughput per volume 40–90 MiB/s", "approximately 100 IOPS on average, with burst capability of up to hundreds of IOPS".

gp3 (https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html): "gp3 volumes do not use burst performance. They can indefinitely sustain their full provisioned IOPS and throughput performance." "consistent baseline IOPS performance of 3,000 IOPS ... You can provision additional IOPS (up to a maximum of 80,000) ... at a ratio of 500 IOPS per GiB of volume size. Maximum IOPS can be provisioned for volumes 160 GiB or larger". "baseline throughput performance of 125 MiB/s ... up to a maximum of 2,000 MiB/s ... at a ratio of 0.25 MiB/s per provisioned IOPS. Maximum throughput can be provisioned at 8,000 IOPS or higher and 16 GiB or larger". "AWS designs gp3 volumes to deliver their provisioned performance 99 percent of the time."
gp2: "Baseline IOPS performance scales linearly between a minimum of 100 and a maximum of 16,000 at a rate of 3 IOPS per GiB"; burst "to 3,000 IOPS"; "I/O credit accrual limit of 5.4 million I/O credits"; "Volumes that are 170 GiB and smaller deliver a maximum throughput of 128 MiB/s ... 334 GiB and larger deliver 250 MiB/s."
io2 (https://docs.aws.amazon.com/ebs/latest/userguide/provisioned-iops.html): "As of April 30, 2025, all new and previously created `io2` volumes are `io2` Block Express volumes." "Provisioned IOPS up to 256,000, with an IOPS:GiB ratio of 1,000:1." "Volume throughput up to 4,000 MiB/s. Throughput scales proportionally at a rate of 0.256 MiB/s per provisioned IOPS. Maximum throughput can be achieved at 16,000 IOPS or higher." "designed to deliver an average latency of under 500 microseconds for 16KiB I/O operations". "Provisioned IOPS SSD volumes deliver their provisioned IOPS performance 99.9 percent of the time."
io1: "from 100 IOPS up to 64,000 IOPS per volume. The maximum ratio of provisioned IOPS to requested volume size (in GiB) is 50:1." "You can achieve up to 64,000 IOPS only on Nitro-based instances. On other instances, you can achieve up to 32,000 IOPS."
st1/sc1 (https://docs.aws.amazon.com/ebs/latest/userguide/hdd-vols.html): st1 "the bucket fills with credits at 40 MiB/s" per TiB, "burst throughput is limited to 250 MiB/s" per TiB, cap "500 MiB/s"; sc1 "12 MiB/s" per TiB baseline, "80 MiB/s" per TiB burst, cap "250 MiB/s".

### 6c. Initialization: new vs snapshot-restored (https://docs.aws.amazon.com/ebs/latest/userguide/initalize-volume.html)
- New volume: "**Empty volumes deliver their maximum performance immediately after creation and do not require initialization.**"
- From snapshot/copy: "the data blocks must be written to the volume before you can access them. For volumes created from snapshots, the data blocks must be downloaded from Amazon S3 to the new volume. ... This process is called volume initialization. During this time, the volume being initialized might experience increased I/O latency and decreased performance. Full volume performance is achieved only once all storage blocks have been downloaded and written to the volume."
- Volume initialization rate: "you can optionally specify an Amazon EBS Provisioned Rate for Volume Initialization (volume initialization rate) that ranges from 100 to 300 MiB/s." "Amazon EBS delivers an average rate that is within 10 percent of the volume initialization rate that you specify for 99 percent of the time." "charges and completion time are based on the size of the snapshot data (not the size of the volume)". Quota: "5,000 MiB/s on the cumulative volume initialization rate ... per Region". Fast snapshot restore: "the volume is fully initialized at creation and it immediately delivers its full performance." Manual: `sudo dd if=/dev/xvdf of=/dev/null bs=1M` or `sudo fio --filename=/dev/xvdf --rw=read --bs=1M --iodepth=32 --ioengine=libaio --direct=1 --name=volume-initialize`.

### 6d. EBS-optimized baseline vs maximum; 30-min rule (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ebs-optimized.html)
"Amazon EBS–optimized instances use an optimized configuration stack and provide additional, dedicated bandwidth for Amazon EBS I/O." Table headers: "Baseline bandwidth (Mbps)" / "Maximum bandwidth (Mbps)"; "Baseline throughput (MB/s, 128 KiB I/O)" / "Maximum throughput (MB/s, 128 KiB I/O)"; "Baseline IOPS (16 KiB I/O)" / "Maximum IOPS (16 KiB I/O)". Footnote 1: "**These instances can sustain the maximum performance for 30 minutes at least once every 24 hours, after which they revert to their baseline performance.**" Footnote 2: "These instances can sustain their stated performance indefinitely. If your workload requires sustained maximum performance for longer than 30 minutes, use one of these instances." "An instance's EBS performance is bounded by the instance type's performance limits, or the aggregated performance of its attached volumes, whichever is smaller." "Some instance types are EBS-optimized by default, and there is no need to enable it and no effect if you attempt to disable it." Bandwidth weighting families named: "M8a, M8g, M8gd, M8i, M8id, M8i-flex, M9g, M9gd".

### 6e. `ModifyVolume` on a live attached volume; modification cadence
API (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ModifyVolume.html): "You can modify several parameters of an existing EBS volume, including volume size, volume type, and IOPS capacity. If your EBS volume is attached to a current-generation EC2 instance type, you might be able to apply these changes without stopping the instance or detaching the volume from it." Parameters: `VolumeId` (Required), `Size` ("must be greater than or equal to the existing size"), `VolumeType`, `Iops` ("valid only for `gp3`, `io1`, and `io2`"; gp3 3,000-80,000; io1 100-64,000; io2 100-256,000; "If you change the volume type to `io1`, `io2`, or `gp3`, the default is 3,000."), `Throughput` ("valid only for `gp3` volumes. The maximum value is 2,000." default 125 when converting), `MultiAttachEnabled`, `DryRun`.
**Cadence — the docs do not say "six-hour cooldown".** Verbatim (API page and https://docs.aws.amazon.com/ebs/latest/userguide/ebs-modify-volume.html): "After you initiate a volume modification, you must wait for that modification to reach the `completed` state before you can initiate another modification for the same volume. You can modify a volume up to four times within a rolling 24-hour period, as long as the volume is in the `in-use` or `available` state, and all previous modifications for that volume are `completed`." The only "six hours" statement is about duration: "Typically, A 1-TiB volume can take up to six hours to be modified." Also: "Size increases take effect once the volume modification reaches the `optimizing` state, which usually takes a few seconds." "Modification time is increased for volumes that are not fully initialized." "You must increase the volume size. You can't decrease the volume size." "A root volume of type `io1`, `io2`, `gp2`, `gp3`, or `standard` can't be modified to an `st1` or `sc1` volume". Supported instances (https://docs.aws.amazon.com/ebs/latest/userguide/modify-volume-requirements.html): "All current generation instances" plus "C1, C3, C4, G2, I2, M1, M3, M4, R3, and R4".

### 6f. `nvme_core.io_timeout` (https://docs.aws.amazon.com/ebs/latest/userguide/timeout-nvme-ebs-volumes.html)
"The default timeout is 30 seconds and can be changed using the `nvme_core.io_timeout` boot parameter. For most Linux kernels earlier than version 4.6, this parameter is `nvme.io_timeout`." "we recommend setting `nvme_core.io_timeout` to the highest value possible. For current kernels, the maximum is 4294967295, while for earlier kernels the maximum is 255. ... the timeout is set to 4294967295 by default for Amazon Linux AMI 2017.09.01 and later." Check via `/sys/module/nvme_core/parameters/io_timeout`. "If I/O latency exceeds the value of this timeout parameter, the Linux NVMe driver fails the I/O and returns an error ... In some cases, your filesystem might be remounted as read-only."

### 6g. Can the guest read provisioned IOPS/throughput from the NVMe device?
**Provisioned values: NOT FOUND IN DOCS** (belief confirmed as far as the docs go). The only guest-side EBS performance data documented is the NVMe "detailed performance statistics" log (https://docs.aws.amazon.com/ebs/latest/userguide/nvme-detailed-performance-stats.html), accessed with `nvme amzn stats /dev/nvme0n1` or the `ebsnvme stats` script, Nitro only. Its complete statistic list: `total_read_ops`, `total_write_ops`, `total_read_bytes`, `total_write_bytes`, `total_read_time`, `total_write_time`, `ebs_volume_performance_exceeded_iops` ("The total time, in microseconds, that IOPS demand exceeded the volume's provisioned IOPS performance."), `ebs_volume_performance_exceeded_tp`, `ec2_instance_ebs_performance_exceeded_iops`, `ec2_instance_ebs_performance_exceeded_tp`, `volume_queue_length`, `read_io_latency_histogram`, `write_io_latency_histogram`. None of these is the provisioned IOPS or throughput value itself; they are counters of time spent above the (unstated) limits. Provisioned values come from `DescribeVolumes` (`iops`, `throughput`).

---

## 7. Reboot vs stop/start; `ReplaceRootVolume`; Capacity Reservations

### 7a. Host behaviour (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html)
"Rebooting an instance is equivalent to rebooting an operating system. **The instance remains on the same host computer** and maintains its public DNS name, private IP address, and any data on its instance store volumes." Stop/start: "When you start your instance, it enters the `pending` state, and **the instance is moved to a new host computer (though in some cases, it remains on the current host)**. When you stop and start your instance, you lose any data on the instance store volumes attached to the previous host computer." Same wording for hibernate. Comparison table, "Host computer" row: Reboot "The instance stays on the same host computer." / Stop/start "The instance is moved to a new host computer (though in some cases, it remains on the current host)." / Hibernate same / Terminate "None". "Instance store volumes" row: Reboot "The data is preserved"; Stop/start, Hibernate, Terminate "The data is erased". "Public IPv4 address" row: Reboot "keeps"; Stop/start "gets a new public IPv4 address, unless ... Elastic IP". Billing row: Reboot "The instance billing hour doesn't change"; stop→start "a new instance billing period, billing a minimum of one minute every time you start your instance."
Reboot page (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-reboot.html): keeps "Public DNS name (IPv4); Private IPv4 address; Public IPv4 address; IPv6 address (if applicable); Any data on its instance store volumes". "if the instance does not cleanly shut down within a few minutes, Amazon EC2 performs a hard reboot."
Exception — reboot migration (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/schedevents_actions_reboot.html): when a `system-reboot` event is scheduled, "If reboot migration is enabled on your instance, a user-initiated reboot attempts to migrate your instance to new hardware." "Instances that receive a `system-reboot` event notification are enabled for user-initiated reboot migration by default." Not supported for "`metal` instances", "Dedicated Host" tenancy, "Instances with instance store volumes", EFA, Auto Scaling groups, Xen. "In-place reboot: Approximately 30 seconds; Reboot with migration: Several minutes." After an AWS `system-reboot`: "The instance moves to a new host. ... Any data on local instance store volumes is preserved."

### 7b. `ReplaceRootVolume` on bare metal (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/replace-root.html)
"**You can replace the root volume for all virtualized instance types and EC2 Mac bare metal instances. No other bare metal instance types are supported.**" Also: "The instance must be in the `running` state." "The instance is automatically rebooted during the process." "the instance remains on the same physical host, so it retains its public and private IP addresses and DNS name." "Instance store volumes remain attached to the instance after the root volume has been restored." "You can't replace the root volume if it is an instance store volume." Task states: `pending`, `in-progress`, `succeeded`, `failing`, `failed`, `failing-detached`, `failed-detached`. Supports `--volume-initialization-rate` 100–300 MiB/s. "The new AMI ID is also reflected in the instance metadata." "The instance identity documents for the instance are automatically updated."

### 7c. Capacity Reservations billing (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/capacity-reservations-pricing-billing.html)
"Capacity Reservations are charged at the equivalent On-Demand rate whether you run instances in reserved capacity or not, including any applicable regional surcharge for Dedicated Instances. If you do not use the reservation, this shows up as unused reservation on your Amazon EC2 bill. When you run an instance that matches the attributes of a reservation, you just pay for the instance and nothing for the reservation. There are no upfront or additional charges." "Billing starts as soon as the Capacity Reservation is provisioned in your account, and it continues while the Capacity Reservation remains provisioned in your account." "Capacity Reservations are billed at per-second granularity, with a minimum of 60 seconds." "Billing discounts for Savings Plans and Regional Reserved Instances apply to Capacity Reservations. ... Billing discounts for zonal Reserved Instances do not apply to Capacity Reservations." CUR 2.0 usage types: `Reservation`, `BoxUsage` (used), `UnusedBox` (unused).

---

## Discrepancies versus the questions as posed

1. "Six-hour cooldown between modifications" — not what the docs say. Rule is "up to four times within a rolling 24-hour period", each after the previous reaches `completed`; "six hours" is a typical duration for a 1-TiB modification.
2. Vendor-specific device-name bytes — docs say "bytes 384:4095 of the controller identification" (not 3072:4095).
3. `Volume` state field is `status` (`creating | available | in-use | deleting | deleted | error`), and `VolumeAttachment` state is also `status`.
4. `RunInstances` has no top-level `AvailabilityZoneId`; use `Placement.AvailabilityZoneId`. `EbsBlockDevice.AvailabilityZoneId` is explicitly unsupported for RunInstances.
5. `MaintenanceOptions` at launch only carries `AutoRecovery`; `RebootMigration` is a post-launch `ModifyInstanceMaintenanceOptions` setting.
6. `launchTime` in `DescribeInstances` is the *last* launch (stop/start resets it); first launch time is the primary ENI attach time; IMDS `pendingTime` is in the identity document, which is regenerated on stop/start.
7. IMDS has no tenancy, CPU-options, or launch-time categories; the API `Placement.tenancy` and `CpuOptions` are the only sources.
8. `hypervisor` in `DescribeInstances` returns `xen` for Nitro too; use `DescribeInstanceTypes.hypervisor` (`nitro | xen`) or IMDS `system` for the real hypervisor.
9. The exact `nvme id-ctrl` `mn`/`sn` dump for instance store is not in the docs; only `nvme list` output (`Amazon EC2 NVMe Instance Storage`, serials like `AWS2C1436F5159EB6614`).

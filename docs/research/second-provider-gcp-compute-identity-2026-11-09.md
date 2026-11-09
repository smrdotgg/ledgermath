# Google Compute Engine: zone, machine-type, CPU-platform and image identity

Date: 2026-11-09

## Scope

A desk check of whether an EC2-shaped Target identity (region + AZ ID + instance type, one pinned AMI, cpuid capture, `-march=native` per landed silicon) survives Google Compute Engine. Covers zone naming, name reporting, custom machine types, CPU platforms and `minCpuPlatform`, other ways to pin silicon, the `machineTypes` record, images, retired names, and create-time options. The pages were read on 2026-11-09. Guide pages say "Last updated 2026-11-06 UTC". In the REST v1 reference, the instances page says 2026-10-29, and the machineTypes, images, zones and disks pages say 2026-10-15.

## Source policy

Primary sources only: docs.cloud.google.com guides, the Compute Engine REST v1 reference, and the current and archived release notes. Pages were fetched raw with curl and rendered with w3m, so quotes are verbatim. "(table cells)" marks quotes taken from flattened tables, and "…" marks elisions. One Confidential VM quote is a fragment and is flagged. Facts that could not be found are marked NOT FOUND.

## Answers at a glance

1. **Zone names.** No current page says zone letters are mapped per project. Google's Regions and zones page said exactly that until early 2025 ("Compute Engine independently maps zones to clusters for each organization"), and the sentence has since been removed without replacement; see the correction in section 1. Zones have a server-defined numeric `id`, but the docs never say it is the same across projects, and no account-independent second identifier is documented. https://docs.cloud.google.com/compute/docs/regions-zones
2. **How names are reported.** In `instances.get`, `zone` and `machineType` are URLs that contain the project ID. On the metadata server, `instance/zone` = `projects/PROJECT_NUM/zones/ZONE`, `instance/machine-type` = `projects/PROJECT_NUM/machineTypes/MACHINE_TYPE`, and `instance/image` = `projects/IMAGE_PROJECT/global/images/IMAGE_NAME`. So the project number is embedded in zone and machine-type, and the image project in image. The `cpu-platform` value format is NOT FOUND. https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
3. **Custom machine types.** The format is `SERIES-custom-VCPUS-MEMORY_MB` (N1 drops the prefix: `custom-4-5120`). Extended memory adds `-ext`, and E2 shared-core uses `e2-custom-small-2304`. Memory is a multiple of 256 "MB", which is really MiB. Ranges vary per series. The name goes in the normal `machineType` URL. Whether `machineTypes.get` answers for a custom name is NOT FOUND. https://docs.cloud.google.com/compute/docs/instances/creating-instance-with-custom-machine-type
4. **CPU platforms.** Most series run on exactly one named processor SKU. Only C4, E2, N2 and N1 are multi-platform, and for C4 and N2 the platform partly follows the shape. `minCpuPlatform` is documented as a floor ("the specified type, or newer generation CPUs"). The platform is stable while running and across live migration. With AUTOMATIC it can change at stop/start. E2 mixes Intel and AMD and forbids `minCpuPlatform`. https://docs.cloud.google.com/compute/docs/cpu-platforms
5. **Other ways to pin silicon.** Each sole-tenant node type names one processor (e.g. `n2-node-80-640` = Cascade Lake, `n2-node-128-864` = Ice Lake). Sole tenancy forbids `minCpuPlatform` and excludes E2, T2D, T2A and C2D. Bare metal `-metal` types exist for C3, C4, C4A, C4D, X4, X5, Z3, Z4D, Z4M, A4X Max and A5X. They require IDPF images and TERMINATE maintenance, and have no Persistent Disk. https://docs.cloud.google.com/compute/docs/nodes/sole-tenant-nodes
6. **Machine-type catalog.** The resource is zonal. Its fields: `guestCpus`, `memoryMb` (MiB), `imageSpaceGb` (never populated), `maximumPersistentDisks`, `maximumPersistentDisksSizeGb`, `isSharedCpu`, `accelerators`, `architecture`, `bundledLocalSsds.partitionCount`/`defaultInterface`, `deprecated`, `zone`, `id`, `name`. It has no bandwidth, disk limits, Local SSD capacity, core count or threads per core. Those are in documentation tables only. https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes
7. **Images.** Images are global. Names follow `debian-V-R-vYYYYMMDD` under `projects/debian-cloud/global/images/...`, and a family resolves to the newest non-deprecated image, possibly different per zone during rollout. Superseded public images become DEPRECATED but stay usable by exact name, and no deletion timeline is published. A copy keeps only `sourceImageId`, and there is no content hash. `instances.get` omits the boot image, while `disks.get` has `sourceImage`/`sourceImageId`. Debian and Rocky update monthly; Ubuntu only for fixes. https://docs.cloud.google.com/compute/docs/images/os-image-lifecycle
8. **Names that do not last.** Yes. Zones `us-central2-a` (2013) and `europe-west1-a` (2015) were turned down. `n1-megamem`→`m1-megamem` (2019) and `x4-megamem-*-metal`→`x4-*-metal` were renamed. Zones and machine types carry a `deprecated` object. https://docs.cloud.google.com/compute/docs/release-notes-archive
9. **Create-time options.** Changing `minCpuPlatform`, Tier_1, nested virtualization, `networkInterfaces`, Spot/preemptible or a compact placement policy needs a stop or restart. Node affinity updates with only a refresh, but needs `minCpuPlatform` cleared first. Confidential VM is described only as part of creating a VM. Each is reported in its own `instances.get` field. https://docs.cloud.google.com/compute/docs/instances/update-instance-properties

## 1. Zone names

- Quote: "Zones and regions are logical abstractions of underlying physical resources."
- URL: https://docs.cloud.google.com/compute/docs/regions-zones
- Gloss: Zones are called logical, but nothing says they are mapped per project.

- Quote: "A standard zone name contains two parts: the region and the zone in the region. For example, the fully qualified name for zone a in region us-central1 is us-central1-a."
- URL: https://docs.cloud.google.com/compute/docs/regions-zones
- Gloss: This is the only naming rule, and it has no per-project caveat.

- Quote: "us-central1-a … Council Bluffs, Iowa, North America" (table cells)
- URL: https://docs.cloud.google.com/compute/docs/regions-zones
- Gloss: One location, series list and CPU list is published per zone name, which implies the name means the same place for everyone.

- Quote: "For an AI zone, the <zone> variable consists of three parts: the string ai …, a number (indicating its deployment group), and a letter (indicating the shared software update schedule). For example, … us-west4-ai2b."
- URL: https://docs.cloud.google.com/compute/docs/regions-zones
- Gloss: A second zone-name grammar exists.

- Quote: "id … Output only. The unique identifier for the resource. This identifier is defined by the server." / "availableCpuPlatforms[] … Output only. Available cpu/platform selections for the zone."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/zones
- Gloss: Zones have a numeric ID (the doc example is `"2210"`), and its stability across projects is undocumented. The zone also lists its CPU platforms.

- Per-project or per-org zone-letter mapping: not on any current page (checked regions-zones, geography-and-regions, viewing-regions-zones, global-regional-zonal-resources). **Correction added 2026-11-09 by the session that commissioned this report:** Google did document it, on the Regions and zones page itself, until early 2025. The three findings below come from Internet Archive copies of Google's own pages.

- Quote: "Compute Engine implements a layer of abstraction between zones and the physical clusters where the zones are hosted. A cluster represents a distinct physical infrastructure that is housed in a data center. Each zone is hosted in one or more clusters and Compute Engine independently maps zones to clusters for each organization. For example, the `us-central1-a` zone for your organization might not map to the same cluster as the `us-central1-a` zone for another organization."
- URL: https://web.archive.org/web/20250101054108/https://cloud.google.com/compute/docs/regions-zones
- Gloss: Zone letters were mapped per organization. The passage is in archived copies dated 2022-06-01, 2023-05-30, 2024-06-02, and 2025-01-01, and absent from copies dated 2025-02-15, 2025-04-01, 2025-05-29, 2025-11-15, and 2026-10-30, and from the live page (last updated 2026-11-06).

- Quote: "Default zone-to-cluster mappings are selected on a per-project basis so that every customer experiences the same capabilities and performance. Within a project, the mapping between a logical zone and a physical cluster is consistent, however another project might have a completely different zone-to-cluster mapping based on the project's zonal resources. A project never has two zones mapped to the same physical cluster." / "Although zone-to-cluster mapping seldom change, changes do occur as the capacity needs and underlying hardware offerings evolve."
- URL: https://web.archive.org/web/20241203022922/https://cloud.google.com/compute/docs/regions-zones/zone-virtualization
- Gloss: The "Zone virtualization" page (last updated 2024-11-27) said the mapping is per project and can change. Its URL now redirects to https://docs.cloud.google.com/docs/geography-and-regions, which does not carry the text.

- Gloss only: nothing on a current page says the mapping was abolished, and nothing says it still holds. No account-independent zone identifier is documented in either period.

## 2. How names are reported

- Quote: "zone … Output only. URL of the zone where the instance resides."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: In `instances.get`, the zone is a URL. The doc example is `"selfLink": "https://www.googleapis.com/compute/v1/projects/myproject/zones/europe-west10-a"` (https://docs.cloud.google.com/compute/docs/instances/specify-min-cpu-platform).

- Quote: "Full or partial URL of the machine type resource to use for this instance, in the format: zones/zone/machineTypes/machine-type."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: The read-back example in the update guide is `https://www.googleapis.com/compute/v1/projects/PROJECT_ID/zones/ZONE/machineTypes/n1-standard-2`.

- Quote: "zone … This value has the following format: projects/PROJECT_NUM/zones/ZONE" / "machine-type … This value has the following format: projects/PROJECT_NUM/machineTypes/MACHINE_TYPE" / "image … This value has the following format: projects/IMAGE_PROJECT/global/images/IMAGE_NAME."
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: Metadata uses the project number. `machine-type` has no zone segment, and `image` carries the image's own project (e.g. `debian-cloud`).

- Quote: "cpu-platform … CPU platform of the VM."
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: The value format is NOT FOUND. Friendly names elsewhere look like "Intel Cascade Lake" and "AMD Milan".

- Quote: "id … The ID of the VM. This is a unique, numerical ID generated by Compute Engine for your project and the zone of the VM."
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: The VM ID is numeric and server-generated. `instance/name` is the bare name.

- Quote: "numeric-project-id … The numeric project ID (project number) of the instance, which is not the same as the project name … This value is different from the project-id metadata entry value."
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: There are two project identifiers. Metadata paths use the number, REST URLs use the ID.

- Quote: "cpuPlatform … Output only. The CPU platform used by this instance."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: This is the landed platform. No format or SKU is given.

- Quote: "resourceStatus.physicalHost … The precise location of your instance within the zone's data center, including the block, sub-block, and host. The field is formatted as follows: blockId/subBlockId/hostId."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: Host-level placement is exposed on every VM.

## 3. Custom machine types

- Quote: "--machine-type=MACHINE_SERIES-custom-NUMBER_OF_VCPUS-AMOUNT_OF_MEMORY_MB … For N1, omit MACHINE_SERIES- and start with custom-."
- URL: https://docs.cloud.google.com/compute/docs/instances/creating-instance-with-custom-machine-type
- Gloss: `n2-custom-8-16384`, and for N1 `custom-8-16384`.

- Quote: "append -ext to the machine type name—for example, --machine-type=n2-custom-48-720896-ext." / "--machine-type=e2-custom-small-2304"
- URL: https://docs.cloud.google.com/compute/docs/instances/creating-instance-with-custom-machine-type
- Gloss: The suffix `-ext` marks extended memory, and E2 shared-core uses a size word.

- Quote: "N4 2 80 Any multiple of 2 … N4D 2 96 … N4A 1 64 Any … N2 2 80 Multiples of 2 (up to 32) or 4 (32 to 80) … N2D 2 96 … N1 1 96 1 or any multiple of 2 … E2 2 32 Any multiple of 2" (table cells: series, min vCPU, max vCPU, allowed). The step is 256 MB for all of them.
- URL: https://docs.cloud.google.com/compute/docs/instances/creating-instance-with-custom-machine-type
- Gloss: Only N4, N4D, N4A, N2, N2D, E2, N1 and G2 offer custom types.

- Quote: "For historical reasons, Google Cloud tools and documentation refer to machine type memory as decimal megabytes (MB) and gigabytes (GB). However, these units represent binary gibibytes (GiB) and mebibytes (MiB), where 1 GB is 2^30 bytes, or 1,024 MB."
- URL: https://docs.cloud.google.com/compute/docs/instances/creating-instance-with-custom-machine-type
- Gloss: "MB" means MiB, including in `memoryMb`.

- Quote: "The on-demand prices for custom machine types include a 5% premium over the on-demand prices for predefined machine types."
- URL: https://docs.cloud.google.com/compute/docs/instances/creating-instance-with-custom-machine-type
- Gloss: Custom types have their own price lines.

- Quote: "To create a custom machine type, provide a URL to a machine type in the following format, where CPUS is 1 or an even number up to 32 … zones/zone/machineTypes/custom-CPUS-MEMORY"
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: The custom name is accepted in the `machineType` slot. "up to 32" is stale (the guide allows 96).

- Quote: "machineType … Name of the machine type to return."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes/get
- Gloss: Whether custom names resolve here is NOT FOUND.

## 4. CPU platforms (core question)

- Quote: "The machine type determines what CPU platform the compute instance runs on."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: This is the general rule. The exceptions follow.

- Quote: "Intel Xeon Platinum 6985P-C Processor | C4" · "Intel Xeon Platinum 8581C Processor | … C4 C4N | … N4" · "Intel Xeon Platinum 8481C Processor | C3 Z3 H3" · "Intel Xeon Platinum 8373C Processor | N2 M3" · "Intel Xeon Gold 6268CL Processor | N2" · "Intel Xeon Gold 6253CL Processor | C2" · "Intel Xeon Scalable Platinum 8173M Processor | E2 m1-megamem … N1" · "Intel Xeon E5-2696V4 Processor | E2 N1" · "AMD EPYC 9B45 | N4D C4D G4 H4D Z4D" · "AMD EPYC 9B14 | C3D" · "AMD EPYC 7B13 | E2 Tau T2D N2D C2D" · "Google Axion Processors with Neoverse V2 Armv9 cores | C4A" · "Google Axion Processors with Neoverse N3 Armv9.2 cores | N4A" · "Ampere Altra Arm Neoverse N1 cores | Q64-30 | Tau T2A" (table cells)
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: Exact SKUs are named. N4, N4D, N4A, N2D (Milan only), C4A, C4D, C3, C3D, C2, C2D, T2D, T2A, H3 and H4D are single-platform. N1 also has Haswell E5-2696V3, Ivy Bridge E5-2696V2 and Sandy Bridge E5-2689.

- Quote: "C4 machine types with: 144 vCPUs 288 vCPUs attached Titanium SSD disks | Intel Granite Rapids … C4 machine types with: 192 vCPUs and no Titanium SSD disks less than 144 vCPUs and no Titanium SSD disks | Intel Granite Rapids Intel Emerald Rapids … E2 | Intel Broadwell AMD EPYC Milan | Not available … N2 with less than 96 vCPUs | Intel Cascade Lake Intel Ice Lake … N2 with 96 or more vCPUs | Intel Ice Lake … N1 | Intel Sandy Bridge Intel Ivy Bridge Intel Haswell Intel Broadwell Intel Skylake" (table cells)
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: Four series are multi-platform. For C4 and N2, the shape partly decides the platform.

- Quote: "C4 Local SSD (-lssd) and bare metal (-metal) instances, as well as instances with 144 or 288 vCPUs, use the 6th generation Intel Granite Rapids processor. All other instances use the 5th generation Intel Emerald Rapids processor."
- URL: https://docs.cloud.google.com/compute/docs/general-purpose-machines
- Gloss: CONTRADICTS the table above, which allows Granite Rapids on small shapes in select zones.

- Quote: "Cascade Lake—the default for machine types up to 80 vCPUs. If you want to create VMs with Ice Lake, you must set it as the minimum CPU platform."
- URL: https://docs.cloud.google.com/compute/docs/general-purpose-machines
- Gloss: N2 defaults to Cascade Lake. The cut-off is 80 here, 96 on the CPU-platforms page, and "less than 80" in the custom section.

- Quote: "The E2 machine series offers both Intel and AMD EPYC processors. The processor is selected for you at the time of VM creation."
- URL: https://docs.cloud.google.com/compute/docs/general-purpose-machines
- Gloss: E2 mixes vendors, and you get no choice.

- Quote: "You can't select a minimum CPU platform for any E2 virtual machine (VM) instance." / "You can't specify a minimum CPU platform for VM instances that were created with shared-core, general-purpose machine types."
- URL: https://docs.cloud.google.com/compute/docs/instances/specify-min-cpu-platform
- Gloss: CONTRADICTION on E2 platforms: the SKU table includes Skylake, but the multi-platform table lists only Broadwell and Milan.

- Quote: "The parameter is named minimum CPU because when this parameter is set, the compute instance can only be hosted on servers that use CPUs of the specified type, or newer generation CPUs."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: It is a floor.

- Quote: "When you specify a value for the minimum CPU, Compute Engine provides that CPU platform for your instance to use. Your compute instance continues to use that CPU platform unless you change it. Your compute instance uses the specified CPU platform even after live migration during a maintenance operation."
- URL: https://docs.cloud.google.com/compute/docs/instances/specify-min-cpu-platform
- Gloss: This reads like a pin. The same page also says "Compute Engine never provides a CPU platform that is older than the one specified", which is floor wording (CONTRADICTION).

- Quote: "If you need your compute instance to always use the default CPU platform that it was created with, then set minimum CPU for the instance to the same value as the default CPU platform. This ensures that the Guest CPU remains the same for the instance for as long as that CPU platform is supported."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: This is Google's recipe for holding a platform. It is a true pin only when the chosen platform is the newest in the series.

- Quote: "The Guest CPU for an instance doesn't change while the instance is running. … If the default CPU platform for the machine type changes in the zone where the instance is running, if you stop and restart the instance, the Guest OS displays the new CPU platform."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: An AUTOMATIC VM can change silicon at stop/start. Reset (which stays RUNNING) is NOT FOUND explicitly.

- Quote: "To keep an instance running during a host event, Compute Engine performs a live migration of the instance to another host server in the same zone."
- URL: https://docs.cloud.google.com/compute/docs/instances/live-migration-process
- Gloss: The platform is kept, but the physical host changes mid-run.

- Quote: "Some machine types can run on more than one CPU platform. For these machine types you can specify a minimum CPU platform for the instance." / "5th Generation AMD EPYC Turin AMD Turin … Google Axion (Neoverse V2 Armv9) Google Axion … Ampere Altra (Arm Neoverse N1) Ampere Altra"
- URL: https://docs.cloud.google.com/compute/docs/instances/specify-min-cpu-platform
- Gloss: Values are friendly names, and the list includes single-platform CPUs. What happens when you set one on a single-platform series is NOT FOUND.

- Quote: "To change the CPU for an existing compute instance, you must first stop the instance." / "Reservations: If you use reservations, your compute instance must use the same CPU platform as the reservation."
- URL: https://docs.cloud.google.com/compute/docs/instances/specify-min-cpu-platform
- Gloss: `setMinCpuPlatform` requires a stopped VM, and reservations also bind the platform.

- Quote: "A compute instance's guest environment reflects the base frequency, regardless of what frequency the CPU is actually running at." / "C4 instances and C4N instances are able to run at all-core-max turbo frequency by setting the AdvancedMachineFeature field to ALL_CORE_MAX."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: cpuid shows the base frequency, and C4 has a performance knob (`advancedMachineFeatures.turboMode`).

- Quote: "For the C4A, N4A, T2D, T2A, H4D, H3, A5X, A4X Max, and A4X machine series, Compute Engine instances always have one vCPU per core. For all other machine series, the compute instances have two vCPUs per core by default."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: SMT comes from the series. `advancedMachineFeatures.threadsPerCore` can disable it.

## 5. Other ways to pin silicon

- Quote: "If you're using sole-tenant nodes, each node uses the CPU platform corresponding to the node type that you defined in the node template."
- URL: https://docs.cloud.google.com/compute/docs/instances/specify-min-cpu-platform
- Gloss: The node type fixes the platform.

- Quote: "n2-node-80-640 Cascade Lake … n2-node-128-864 Ice Lake … n1-node-96-624 Skylake … n4-node-224-1372 Emerald Rapids … c4-node-288-576 Granite Rapids … c3-node-176-352 Sapphire Rapids … c4d-node-384-720 AMD EPYC Turin … c4a-node-72-144 Google Axion" (table cells)
- URL: https://docs.cloud.google.com/compute/docs/nodes/sole-tenant-nodes
- Gloss: Sole tenancy is the documented way to get one exact platform on N2 or N1.

- Quote: "You can't use sole-tenant VMs with the following machine series and types: T2D, T2A, E2, C2D, A3 Ultra, A3 Edge, A4, A4X, or bare metal instances. / Sole-tenant VMs can't specify a minimum CPU platform."
- URL: https://docs.cloud.google.com/compute/docs/nodes/sole-tenant-nodes
- Gloss: E2 cannot be pinned by any route.

- Quote: "When you select a machine type with a name that contains -metal, you create a bare metal instance in the same way that you create a VM instance." / "Bare metal instances also expose all CPU performance counters and built in CPU accelerators."
- URL: https://docs.cloud.google.com/compute/docs/instances/bare-metal-instances
- Gloss: Examples include `c3-standard-192-metal`, `c4d-highmem-384-metal`, `c4a-highmem-96-metal`, `z3-highmem-192-highlssd-metal` and `x4-480-6t-metal`.

- Quote: "Bare metal instances don't run a hypervisor and don't support gVNIC or VirtIO." / "Bare metal instances don't support Persistent Disk." / "The maintenance behavior must be set to TERMINATE. Live migration is not feasible." / "you can only use OS images that support IDPF."
- URL: https://docs.cloud.google.com/compute/docs/instances/bare-metal-instances
- Gloss: Bare metal brings its own image, disk and maintenance constraints.

## 6. The machine-type catalog record

- Quote: "\"guestCpus\": integer, \"memoryMb\": integer, \"imageSpaceGb\": integer, \"maximumPersistentDisks\": integer, \"maximumPersistentDisksSizeGb\": string, \"deprecated\": {…}, \"zone\": string, \"selfLink\": string, \"isSharedCpu\": boolean, \"accelerators\": [{\"guestAcceleratorType\", \"guestAcceleratorCount\"}], \"architecture\": enum, \"bundledLocalSsds\": {\"partitionCount\": integer, \"defaultInterface\": string}" (JSON representation; also `kind`, `id`, `creationTimestamp`, `name`, `description`)
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes
- Gloss: This is the complete field set.

- Quote: "guestCpus … The number of virtual CPUs that are available to the instance." / "memoryMb … The amount of physical memory available to the instance, defined in MB." / "imageSpaceGb … [Deprecated] This property is deprecated and will never be populated with any relevant values." / "maximumPersistentDisksSizeGb … Maximum total persistent disks size (GB) allowed."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes
- Gloss: These are the units. "MB" is MiB (section 3).

- Quote: "zone … Output only. The name of the zone where the machine type resides, such as us-central1-a."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes
- Gloss: The resource is zonal: `GET /projects/{project}/zones/{zone}/machineTypes/{machineType}`.

- Quote: "bundledLocalSsds.partitionCount … The number of partitions."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes
- Gloss: It gives a partition count but no capacity. The docs say `-lssd` types attach "375 GiB Titanium SSD or Local SSD disks" (https://docs.cloud.google.com/compute/docs/machine-resource).

- Quote: "You can find the per-instance maximum egress bandwidth for every machine type listed on its specific machine family page"
- URL: https://docs.cloud.google.com/compute/docs/network-bandwidth
- Gloss: Bandwidth is in documentation only.

- Quote: "This document lists performance limits by machine series and Google Cloud Hyperdisk type."
- URL: https://docs.cloud.google.com/compute/docs/disks/hyperdisk-perf-limits
- Gloss: Disk IOPS and throughput limits are in documentation only. Physical cores and threads per core are not in the API either (derive them from section 4).

## 7. Images

- Quote: "Global resources are accessible by resources in any region or zone, For example, virtual machine (VM) instances from different zones can use the same global image."
- URL: https://docs.cloud.google.com/compute/docs/regions-zones/global-regional-zonal-resources
- Gloss: Images are global, unlike AMIs, which are per region.

- Quote: "projects/debian-cloud/global/images/family/debian-9 / Alternatively, use a specific version of a public operating system image: projects/debian-cloud/global/images/debian-9-stretch-vYYYYMMDD"
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: These are the family and exact path forms.

- Quote: "debian-V … debian-V-R-vYYYYMMDD … Monthly … OS images are marked deprecated but are still available for use." / "rocky-linux-V … rocky-linux-V-vYYYMMDD … Monthly" / "ubuntu-V-lts … ubuntu-V-R-vYYYYMMDD … Critical bug or security issues" / "Windows Server … OS images are deleted on the EOS date." (table cells)
- URL: https://docs.cloud.google.com/compute/docs/images/os-image-lifecycle
- Gloss: This gives the name grammar and cadence (the Rocky typo is on the page).

- Quote: "the debian-13-trixie-v20260827 with the updates becomes debian-13-trixie-v20260902. / The debian-13 image family now points to the new debian-13-trixie-v20260902 OS image. / The previous OS image (debian-13-trixie-v20260827) is marked deprecated."
- URL: https://docs.cloud.google.com/compute/docs/images/os-image-lifecycle
- Gloss: A superseded image becomes DEPRECATED. A timeline to OBSOLETE or DELETED is NOT FOUND.

- Quote: "You can no longer use the image family. However, you can still use some or all of the OS images by referencing them directly with the exception of Windows where all OS images are deleted at EOS."
- URL: https://docs.cloud.google.com/compute/docs/images/os-image-lifecycle
- Gloss: After EOS, exact names still work, but only for "some or all" images.

- Quote: "Returns the latest image that is part of an image family and is not deprecated."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/images/getFromFamily
- Gloss: This is how `images.getFromFamily` resolves a family.

- Quote: "During image rollout, the latest version of an image in an image family might differ in different zones."
- URL: https://docs.cloud.google.com/compute/docs/images/image-families-best-practices
- Gloss: Family resolution is per zone during a rollout, so pin exact names.

- Quote: "ACTIVE: the image is active and can be used as normal." / "DEPRECATED: the image is marked deprecated but can still be used to create a VM. New links to this image are allowed. Image families no longer point to this image … Deprecating an image is irreversible." / "OBSOLETE: … no longer available for use. An error message is returned if you try to use this image in a request. Existing links to this image are still allowed." / "DELETED: this image is deleted. An error message is returned if you try to use a deleted image."
- URL: https://docs.cloud.google.com/compute/docs/images/deprecate-custom
- Gloss: Only ACTIVE and DEPRECATED images can create VMs. The REST reference agrees: DEPRECATED returns "successfully, but with a warning", and OBSOLETE or DELETED are "rejected".

- Quote: "id … Output only. The unique identifier for the resource. This identifier is defined by the server."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/images
- Gloss: Images have a numeric ID as well as an RFC1035 name.

- Quote: "IMAGE_PROJECT: Optional: the project the source image is located in. Use this parameter if you want to copy an image from another project."
- URL: https://docs.cloud.google.com/compute/docs/images/create-custom
- Gloss: You can copy a public image into your own project.

- Quote: "sourceImageId … Output only. The ID value of the image used to create this image. This value may be used to determine whether the image was taken from the current or a previous instance of a given image name." / "rawDisk.sha1Checksum … [Deprecated] This field is deprecated."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/images
- Gloss: A copy keeps the source ID only. No content hash is documented.

- Quote: "disks[].initializeParams … [Input Only] Specifies the parameters for a new disk that will be created alongside the new instance."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: `instances.get` does not echo the boot image.

- Quote: "sourceImageId … This value identifies the exact image that was used to create this persistent disk." / "sourceImage … The source image used to create this disk. If the source image is deleted, this field will not be set."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/disks
- Gloss: Use `disks.get` on the boot disk. Of the two fields, only the ID survives deletion of the image.

## 8. Names that do not last

- Quote: "Deprecated us-central2-a zone. us-central2-a has been deprecated and will be permanently turned down by December 31st, 2013." / "Removed europe-west1-a zone, which was deprecated on October 15, 2014." (March 30, 2015)
- URL: https://docs.cloud.google.com/compute/docs/release-notes-archive
- Gloss: Zones have been retired.

- Quote: "Renamed n1-megamem and n1-ultramem machine types to m1-megamem and m1-ultramem respectively." (September 03, 2019) / "All *-d machine types have been deprecated and no longer supported." (December 03, 2013)
- URL: https://docs.cloud.google.com/compute/docs/release-notes-archive
- Gloss: Machine types have been renamed and retired.

- Quote: "x4-960-16t-metal (previously x4-megamem-960-metal)"
- URL: https://docs.cloud.google.com/compute/docs/instances/bare-metal-instances
- Gloss: This is a recent rename.

- Quote: "The A3 Edge accelerator-optimized machine type is no longer available in Turin, Italy: europe-west12-b."
- URL: https://docs.cloud.google.com/compute/docs/release-notes
- Gloss: A machine type can disappear from a single zone.

- Quote: "deprecated … The deprecation status associated with this machine type. Only applicable if the machine type is unavailable." / "deprecated.deprecated … This is only informational and the status will not change unless the client explicitly changes it."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/machineTypes
- Gloss: The object holds `state`, `replacement`, `deprecated`, `obsolete` and `deleted`. Zones have the same object plus `status` "either UP or DOWN".

## 9. Create-time options

- Quote: "The following properties require a restart (RESTART) to update: … enableNestedVirtualization … machineType · minCpuPlatform · networkInterfaces · networkPerformanceConfig … resourcePolicies: if the policy specifies only one availability domain · scheduling: all scheduling properties, except … The scheduling.nodeAffinities field" / "The following properties only require a refresh (REFRESH) to update: … nodeAffinities"
- URL: https://docs.cloud.google.com/compute/docs/instances/update-instance-properties
- Gloss: This is the master mutability list. `confidentialInstanceConfig` is not in it.

- Quote (sole tenancy): "To migrate a VM to a sole-tenant node, remove the minimum CPU platform specification by setting it to automatic before updating the VM's node affinity labels."
- URL: https://docs.cloud.google.com/compute/docs/nodes/sole-tenant-nodes
- Gloss: Set it at create or update it later. It is reported in `scheduling.nodeAffinities[]` (`key`, `operator` IN/NOT_IN, `values`).

- Quote (Tier_1): "Your instance must already have a gVNIC interface associated with it; you can't edit your instance to add a network interface. To update the network configuration, you must stop and restart the instance." / "Purchasable stock keeping units (SKUs) for Tier_1 networking are excluded from committed use discounts."
- URL: https://docs.cloud.google.com/compute/docs/networking/configure-vm-with-high-bandwidth-configuration
- Gloss: Set it at create or while stopped. It is reported in `networkPerformanceConfig.totalEgressBandwidthTier` (`TIER_1` / `DEFAULT`).

- Quote (Confidential VM): "You can create a Confidential VM instance as part of creating a new" (fragment; the HTML element ends there, and a summarising fetch rendered "…new Compute Engine virtual machine.")
- URL: https://docs.cloud.google.com/confidential-computing/confidential-vm/docs/create-a-confidential-vm-instance
- Gloss: Create-time by implication. It is reported in `confidentialInstanceConfig.enableConfidentialCompute` and `.confidentialInstanceType`.

- Quote (Spot/preemptible): "scheduling.preemptible … This can only be set during instance creation or while the instance is stopped and therefore, in a TERMINATED state." (instances reference) / "Spot prices can change up to once every day."
- URL: https://docs.cloud.google.com/compute/docs/instances/spot
- Gloss: Set it at create or while stopped. It is reported in `scheduling.provisioningModel` (`SPOT`), and the price moves daily.

- Quote (compact placement): "You can apply a compact placement policy to an existing compute instance … 1. Stop the compute instance. 2. … use the gcloud compute instances add-resource-policies command."
- URL: https://docs.cloud.google.com/compute/docs/instances/use-compact-placement-policies
- Gloss: Set it at create or while stopped. It is reported in `resourcePolicies[]`, and topology appears in `resourceStatus.physicalHostTopology`.

- Quote (nicType): "networkInterfaces[].nicType … The type of vNIC to be used on this interface. This may be gVNIC or VirtioNet." (instances reference) / "gVNIC replaces VirtIO-Net as the only supported network interface in Compute Engine for all new machine types (Generation 3 and onwards)."
- URL: https://docs.cloud.google.com/compute/docs/networking/using-gvnic
- Gloss: Effectively create-time. In-place change is NOT FOUND, and `networkInterfaces` changes need a restart.

- Quote (nested virtualization): "Enable nested virtualization directly on a new or existing VM by setting the enableNestedVirtualization field to true while creating the VM or by updating the VM."
- URL: https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/enabling
- Gloss: Set it at create or update with a restart. It is reported in `advancedMachineFeatures.enableNestedVirtualization`.

## Surprises for an EC2-shaped design

1. There are no AZ IDs. Zone names were documented as mapped per organization until early 2025 (section 1, correction); the current pages are silent, and the zone `id` is not documented as stable across projects.
2. AI zones use a second name grammar (`us-west4-ai2b`).
3. On N1, N2, E2 and C4, the machine type does not fix the CPU. E2 mixes Intel and AMD with no control, and for N2 and C4 the shape also shifts the platform.
4. `minCpuPlatform` is a floor. It works as a pin only at the newest platform of a series, and the docs word it both ways.
5. Silicon can change at stop/start for AUTOMATIC VMs. Live migration keeps the platform but moves the host.
6. Sole-tenant node types name one exact processor, but they forbid `minCpuPlatform` and exclude E2.
7. The guest sees the base frequency, and C4/C4N have a `turboMode` knob.
8. Metadata paths embed the project number, while REST URLs embed the project ID. Metadata `machine-type` has no zone segment.
9. "MB" is MiB. Custom machine names are open-ended and carry a 5% premium.
10. The machineTypes record has no bandwidth, disk limits, Local SSD capacity or core count. Those must be scraped from documentation.
11. Images are global (one name everywhere), but image families resolve per zone during rollouts.
12. Superseded public images stay DEPRECATED and usable with no published deletion date. Windows, SQL Server and Fedora CoreOS images are deleted at EOS.
13. Images have no content hash. Identity is name plus numeric `id`, and copies keep only `sourceImageId`.
14. `instances.get` omits the boot image. Use `disks.get` or metadata `instance/image`.
15. Zones and machine types have been retired and renamed.
16. Tier_1, `minCpuPlatform`, nested virtualization, compact placement and Spot all need a stop to change, and Confidential VM is create-only. `resourceStatus.physicalHost` exposes the host.

## NOT FOUND and contradictions

- NOT FOUND on current pages: whether zone letters map differently per project or org (documented as per organization until early 2025; see section 1), and whether the zone `id` is the same across projects.
- NOT FOUND: the value format of metadata `cpu-platform` and of `instances.get` `cpuPlatform`.
- NOT FOUND: whether `machineTypes.get` or `list` resolve custom names.
- NOT FOUND: `minCpuPlatform` behaviour on single-platform series, and whether reset can change the platform.
- NOT FOUND: a timeline for superseded public images to become OBSOLETE or DELETED.
- NOT FOUND: any image content hash.
- NOT FOUND: an explicit "cannot change `nicType`" or "cannot convert to Confidential VM" (both only implied).
- CONTRADICTION: E2 platforms. The SKU table lists Skylake, Broadwell and Milan; the multi-platform table lists Broadwell and Milan.
- CONTRADICTION: C4. The general-purpose page says small shapes use Emerald Rapids only; the CPU-platforms page says Granite Rapids or Emerald Rapids.
- CONTRADICTION: the N2 Ice Lake cut-off is 80 vCPUs, 96 vCPUs, or "less than 80", depending on the page.
- CONTRADICTION: `minCpuPlatform` is described as a floor ("or newer generation") and as a pin ("provides that CPU platform").
- CONTRADICTION: custom vCPUs. The REST reference says "up to 32"; the guide allows up to 96.
- STALE: the regions page says us-central1-a "by default uses an Intel Haswell processor".

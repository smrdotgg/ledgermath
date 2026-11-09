# Second-provider validation of the abstraction, on paper

Date: 2026-11-09. Written for [Second-provider validation of the abstraction, on paper](https://github.com/smrdotgg/ledgermath/issues/31). A rough take to react to. It builds nothing and decides nothing.

**Walked.** `gcp.compute` as the Machine Kind and `cloudflare.r2` as the Service Kind, against the shapes fixed by [Target taxonomy and identity](https://github.com/smrdotgg/ledgermath/issues/18), [Registry contents and environment schema for aws.ec2 and aws.s3](https://github.com/smrdotgg/ledgermath/issues/29), [Provider abstraction and declarative run spec](https://github.com/smrdotgg/ledgermath/issues/22), and [Service benchmark trustworthiness](https://github.com/smrdotgg/ledgermath/issues/19).

**Why these two.** Compute Engine is where the map expected the silicon draw to be the norm, and it has image families where EC2 has AMIs. R2 has no Machine Kind beside it, so every Station on it binds a box in one provider to a Service in another, which no AWS Station does. `hetzner.cloud` and `gcp.storage` were not walked.

**Evidence.** Three primary-source reports beside this file, every claim with a verbatim quote and its URL:

- [Compute Engine: identity, silicon, catalog, images](second-provider-gcp-compute-identity-2026-11-09.md)
- [Compute Engine: box state, network, controller](second-provider-gcp-compute-box-2026-11-09.md)
- [Cloudflare R2](second-provider-cloudflare-r2-2026-11-09.md)

"Not documented" below means a report looked and found nothing. Such items are settled by one request when a Provisioner is built, the way #29 left two S3 checks.

## The short version

Taken one Kind at a time, the shapes hold. Identity in the provider's words, the slug, the registry as data, captured capabilities, as-booted values, the Capture's sections, the image pin, and the event contract each took a Google Kind and a Cloudflare Kind with different contents and no change of shape.

What does not hold yet is one Benchmark across several Kinds. That is where the decisions are.

| | Misfit | Bites when | Suggested route |
|---|---|---|---|
| 1 | A Variant, a `matches` function, and a binary are each written in one Kind's words, so nothing ports to a second Kind except by coincidence of spelling | The first Station on a second Kind. Sooner: the first Variant merged with a `catalog_` fact in it is AWS-only for good | New ticket |
| 2 | The path between two roles is an `aws.ec2` state key named for S3 | Any Service outside AWS, and `aws.cloudfront` inside it | New ticket |
| 3 | The controller's silent SSH connection is cut by an idle timer on Google's network, and on Amazon's newest instance types | A Run longer than 10 minutes on Compute Engine; longer than 350 seconds on a Nitro v6 instance type | Scope note on [The Visit flow, from scheduler to upload](https://github.com/smrdotgg/ledgermath/issues/35) |
| 4 | `pins_silicon` is one boolean per Kind, and the four-step sort would file a silicon choice as a state key | N1, N2, E2, and C4 on Compute Engine; Lambda, by architecture | Ruling in this ticket; fog entry rewritten |

Misfit 3 affects the AWS build as specified today. The other three change nothing in the two AWS Kinds now specified, though misfit 1 decides what the first Variants should and should not name.

Seven smaller points, each with a proposed answer and none needing a ticket, are listed [at the end](#smaller-rulings).

## Misfit 1: nothing on the Benchmark side ports across Kinds

#18 intends one Variant to span Kinds: "a Variant such as `http_get / 1 MiB` binds unchanged to S3 Standard, S3 Standard-IA, and CloudFront". That is already two Kinds inside AWS. The shapes #22 fixed reach into a single Kind's vocabulary in three places.

**The Variant's role block.** #22's own example reads:

```ts
box: { requires: { properties: { catalog_memory_mib: { type: "integer", minimum: 8192 } } } }
```

`catalog_memory_mib` is an `aws.ec2` fact, named after `MemoryInfo.SizeInMiB`. Compute Engine's catalog calls the same number `memoryMb`, so by #29's naming rule its fact is `catalog_memory_mb`. CI requires every property to name a registered fact of the bound Kind, so a Station binding this Variant to `gcp.compute/us-central1-a/c3-standard-8` fails. The Variant is frozen once merged, so it cannot be reworded. A second Variant under another name is a different Station identity, and "the same Variant on two Targets", the comparison the product exists for, is lost.

**`benchmark.ts`.** The `matches` function in #22's example reads `env.kernel_cpus_online`, a key #22 added to "the `aws.ec2` environment part". The function belongs to the Benchmark and the key to one Kind.

**The binary.** It reads `LM_SERVICE_URL_REGIONAL`, an `aws.s3` output; R2 has one endpoint and no Regions. Under #19 it sends `x-amz-server-side-encryption: AES256` on every PUT; R2's compatibility table marks that request header not implemented. Nothing declares which outputs a role's binary reads, so CI checks only that the bound Kind is of the right sort, and the failure arrives at run time.

**What the walk shows.** Every `aws.ec2` registry entry is observed either on the box or in the EC2 API. #22's `Observer` type already has exactly those two arms.

- The box arm is Linux's, not Amazon's. All of it carried to Compute Engine unchanged: `thp`, `thp_defrag`, `aslr`, `numa_balancing`, `clocksource`, `cpu_governor`, `c_states`, the file fixtures, `kernel_usable_memory_kb`, `kernel_physical_cores`, `kernel_cpus_online`, the Capture's processor and kernel sections, and `lm-capture` itself.
- The API arm is the provider's, and none of it carried: `s3_route`, `cpu_credits`, `bandwidth_weighting`, the `ebs` arm of `disk`, every `catalog_` fact.

**A candidate answer.** The box arm becomes a module that every Machine Kind's registry includes verbatim, the way a Benchmark spreads the harness's HTTP vocabulary into its `events`. A Variant that names only that module's keys can be stationed on any Machine Kind, by declaration. A Variant that names `catalog_memory_mib` or `disk.kind: "ebs"` is tied to its Kind, which is honest: gp3 at 3,000 IOPS is an Amazon thing. A role declares the outputs its binary reads, and CI checks that the bound Kind offers them.

Whether Service Kinds get such a module is the harder half. `aws.s3` and `cloudflare.r2` speak one protocol and still differ in the checksum key (see the R2 walk), and ADR-0015 was written against shared vocabulary, though for identity only.

**The alternatives.** Per-Kind blocks inside one Variant, which means appending to a frozen thing and asserting an equivalence nothing checks. Or Variants never span Kinds and the data interface groups them by Benchmark plus `params`, which are already free of Kind words; names multiply and every `state` requirement is restated per Kind.

**Cheap now, frozen later.** Until this is decided, a `requires` block that can say it with a `kernel_` fact should. #22's example would read `kernel_usable_memory_kb`.

## Misfit 2: the path between two roles is named for S3

`s3_route` (`gateway | public`) lives in the `aws.ec2` registry. Its observer reads the route to S3's prefix list. CI's one cross-role rule, "`gateway` rejected on a cross-Region Station", is hard-coded for the pair. #19 then made `public` the only thing that gives a box a way out: "no internet route unless a Station requires `public`".

Bind `box` to `aws.ec2` and `service` to `cloudflare.r2`:

- The box needs an internet gateway and a public address, and the only way to ask is `s3_route: public` on a Station with no S3 in it.
- The observer for `public` checks that no route to S3's prefix list exists, a list R2 traffic would never match.
- CI must reject `gateway` for a reason it has no data for: R2 is not behind the gateway endpoint.

The same happens inside AWS on the day `aws.cloudfront` is bound, since CloudFront is reached over the internet.

On Compute Engine the equivalent key has three values. A VM reaches Cloud Storage from an external IP ("the traffic stays within Google Cloud and is not sent through the public internet"), through Private Google Access (the subnet flag `privateIpGoogleAccess` plus a route whose next hop is `default-internet-gateway`), or through a Private Service Connect endpoint with a hostname of its own (`storage-<endpoint>.p.googleapis.com`, the analogue of `url_interface`). All three are observable from the API, so the pattern of the key holds. Its name and its CI rule do not.

**The gap underneath.** Which paths reach which Service Kind is a fact about a pair of Kinds, and `Registry<K>` describes one Kind. #18 saw it coming: "no Station-level requirement block exists yet".

**A candidate answer.** Split the key in two. One key for the box's way out to the internet, which any Service outside the provider's network requires. One key per private path a Machine Kind offers to a named Service Kind, which is what `s3_route: gateway` is. Each registry lists which paths reach it, so the CI rule becomes data.

## Misfit 3: the silent SSH connection does not survive

ADR-0023 has the controller send nothing during a Run, keepalives off, "because the controller is in the same VPC no NAT gateway closes the idle connection". `lm-exec` holds the child's output in memory until exit, so the connection carries no packet for the whole Run.

**Google.** "VPC networks automatically drop idle TCP connections after ten minutes. You can't change this limit, but you can use TCP keepalives to prevent connections to instances from becoming idle." ([VPC quotas](https://docs.cloud.google.com/vpc/docs/quota)) The nearest thing to a Fargate task, a Cloud Run job with Direct VPC egress, adds its own "timeout after 10 minutes of idle time for requests from your container to VPC", and a job running longer than an hour "might experience connection breaks" when Google migrates it. What happens to a packet in each direction after the tracking entry expires is not documented.

**Amazon, which is in scope.** Security groups track an SSH flow that is admitted from a security group. The idle timeout for an established TCP flow is "350 seconds for Nitro v6 instance types (excluding P6e-GB200); 432000 seconds for all other instance types", and it can be set from 60 to 432,000 seconds per network interface. ([Connection tracking](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-connection-tracking.html)) Today's design is fine on `c6i.metal`. On a Nitro v6 type a Run longer than about six minutes loses its connection unless the box's interface is launched with the timeout raised. That would be a bundle constant with a read-back, by #19's sweep rule. Not checked here: which instance types are Nitro v6, and whether the timeout on a Fargate task's interface can be set.

**On Compute Engine no setting helps.** A Run over ten minutes needs one of two things. A kernel keepalive puts one packet and one interrupt on the box inside the measured interval every few minutes; it is small, and it ends "no packet of ours reaches the box until the child exits". Or the controller holds no connection: it starts `lm-exec` detached, hangs up, and comes back, which needs a way to know when without asking.

**Route.** The Visit flow owns step 8, "Wait, sending nothing", and the Visit time limit, so this is a scope note there, with ADR-0023 amended when that ticket resolves. Two more lines belong in the same note:

- Where the controller runs is a fact of the Machine Kind: Fargate in the runner VPC on AWS, a Cloud Run job on Google. #22 states it for AWS only.
- A Visit whose Station crosses providers needs the other provider's credentials inside the controller. For R2 that is a Cloudflare API token with admin scope on R2, which nothing in #22 places.

## Misfit 4: silicon, and the `cpu` identity field, tried

**What Compute Engine does.** The draw is narrower than the map's fog assumed. Most series run on one named processor: C3 on the Xeon Platinum 8481C, N4 on the 8581C, C3D on the EPYC 9B14, C4A on Axion. Four series can land on more than one:

| Series | Platforms | Can it be asked? |
|---|---|---|
| N2 | Cascade Lake or Ice Lake below 96 vCPUs | `minCpuPlatform: "Intel Ice Lake"` gets Ice Lake. Cascade Lake is the default, and a floor of Cascade Lake still admits Ice Lake by the floor's own wording |
| N1 | Sandy Bridge, Ivy Bridge, Haswell, Broadwell, Skylake | A floor only |
| C4 | Granite Rapids or Emerald Rapids, by shape and zone | A floor only |
| E2 | Intel or AMD | No. "You can't select a minimum CPU platform for any E2" instance, and sole tenancy excludes E2 |

`minCpuPlatform` is a floor: "the compute instance can only be hosted on servers that use CPUs of the specified type, or newer generation CPUs". Google's own pages also word it as a pin in one place; the floor reading is the one its name and its definition give. It pins only when it names the newest platform of the series, and only until Google adds a newer one. A sole-tenant node type does pin (`n2-node-80-640` is Cascade Lake), at the price of renting the node. The landing is reported in `instances.get` as `cpuPlatform` and on the metadata server as `instance/cpu-platform`. An instance with no floor set can change platform across a stop and start.

**E2 breaks an assumption.** #18 rests bounded relaunch on "an instance type never draws across vendors". E2 does.

**The field, tried.** It works, and it comes out better than the fog sketched, in three ways.

1. The value need not be "taken from the Capture". Google has a word for the silicon (`Intel Ice Lake`), reports it in two places, and lists the choices per zone in `zones.get.availableCpuPlatforms[]`. So the field is `cpu_platform`, the API name in snake case with the provider's string verbatim, like every other identity field. Its exact value format is not documented; one `instances.get` settles it.
2. Realizing it needs nothing new. Where the wanted platform is the newest of its series, the Provisioner sets the floor. Otherwise it launches and rejects, which is `launch_attempts` as #18 already has it.
3. "Absent" keeps today's meaning, so no existing Target changes: nothing is asked for, and the bound profile says which landing counts. That is how an M5 Target works now.

Present, it makes two Targets of one machine type, each with its own profile and Series: `gcp.compute/us-central1-a/n2-standard-8?cpu_platform=Intel Ice Lake`. The field is coarser than the CPU profile. It narrows the draw and the Capture still judges, stepping included.

AWS has no such word in its API, so the fog's sketch stands there: the value would come from the box.

**Two things the trial found wrong in the fixed shapes.**

- `pins_silicon` is one boolean per Kind. On Compute Engine the answer differs by machine series: C3 pins by construction, N2 pins at Ice Lake, E2 cannot. It already differs inside one AWS Kind: #18's own words are "Lambda on x86_64". Proposed: drop it from `Registry`; a Machine Target whose entry binds no `profile` accepts only level Variants.
- #18's four-step sort asks whether an option fixed at creation has "its own price line", and makes it identity only if it does. `minCpuPlatform` has no price line, so the sort files it as a state key. Then two Stations on one Target could require two silicons, against "one Target, one native profile". Proposed: a rule ahead of step 3, that an option which selects the silicon is identity.

**Proposed outcome.** No field is added now, since nothing in AWS scope needs one. The fog entry is rewritten to the shape above.

## `gcp.compute`, bullet by bullet

### Identity and slug

Required `zone` and `machine_type`. Slug `gcp.compute/us-central1-a/n2-standard-8`.

- **Per-account names.** `instances.get` reports both as URLs holding the project ID. The metadata server reports `projects/<project number>/zones/us-central1-a` and `projects/<project number>/machineTypes/n2-standard-8`. Identity takes the last path segment, the resource's own name. The observer strips a documented prefix and then compares bytes; that is a split, not a translation table.
- **No `region` field.** Neither the instance nor the metadata server reports one. ADR-0015 lets the Kind leave it out.
- **Zone names have no account-independent form.** Google documented until early 2025 that "Compute Engine independently maps zones to clusters for each organization. For example, the `us-central1-a` zone for your organization might not map to the same cluster as the `us-central1-a` zone for another organization." The sentence is in archived copies of [Regions and zones](https://web.archive.org/web/20250101054108/https://cloud.google.com/compute/docs/regions-zones) from June 2022 to 1 January 2025 and gone by 15 February 2025. The [zone virtualization page](https://web.archive.org/web/20241203022922/https://cloud.google.com/compute/docs/regions-zones/zone-virtualization) that explained it ("another project might have a completely different zone-to-cluster mapping") now redirects elsewhere. The current page says nothing either way, and no zone ID exists. So `zone` is the only name there is, ADR-0014's rule is met vacuously, and the caveat goes in the Kind's description: a Series on `us-central1-a` is our project's `us-central1-a`. The Run already records the project.
- **Optional fields.** Tier_1 networking has its own SKU and changes only across a stop, so #18's step 3 makes it an optional identity field with the provider's default. Sole tenancy is the odd one: node affinity can be updated on a live VM, so step 2 would call it a state key, although it changes what is paid for and can change the silicon. The rule proposed under misfit 4 catches it.
- **Custom machine types** put dialed numbers into the one slot identity takes verbatim: `n2-custom-8-16384` is 8 vCPUs and 16,384 MiB, chosen by us. #18 says a number we dial "is a requirement a Variant places on the Target, never identity". Whether `machineTypes.get` answers for a custom name is not documented, and a Target's facts come from that record. Proposed: custom types are not Targets until someone wants one measured.
- **Names do not last.** Google renamed `n1-megamem` to `m1-megamem` in 2019 and `x4-megamem-960-metal` to `x4-960-16t-metal` since, with the hardware unchanged. Under ADR-0016 the old Target's observer then reads a new name, the Target is retired, and a new one starts a new Series. That is correct by the rules and it splits a Series on a rename.

### Can `native` be pinned?

Yes on every single-platform series, with today's shapes. See misfit 4 for the rest.

### The registry

| `aws.ec2` key | On Compute Engine | Verdict |
|---|---|---|
| `cpu_governor` | "Compute Engine instances don't provide any facilities for customer control of P-states". Expect `unavailable` on guests; `-metal` types not documented | Fits. Capabilities are captured, not typed |
| `turbo` | No guest control documented. C4 and C4N take `advancedMachineFeatures.turboMode: ALL_CORE_MAX` through the API | A different key, `turbo_mode`, API-realized, with one observer: the guest "reflects the base frequency, regardless of what frequency the CPU is actually running at" |
| `c_states` | C4, C4N, and a few C2, C2D, and M2 shapes get MWAIT hints; expect `unavailable` elsewhere | Fits, captured |
| `smt` | `advancedMachineFeatures.threadsPerCore`, 1 or 2, at creation or with a restart; fixed at one on Arm, T2D, H3, H4D; no switch on bare metal | Fits exactly: the same two observers, the same not-alternatable flag, the same grouping of Visits |
| `thp`, `thp_defrag`, `aslr`, `numa_balancing`, `clocksource` | The kernel's | Unchanged. As-booted values come from the image |
| `s3_route` | Three paths to Cloud Storage | Misfit 2 |
| `cpu_credits` | Shared-core bursting is automatic and no option turns it off | No equivalent; the key is absent |
| `bandwidth_weighting` | Nearest is Tier_1 networking, which has a price line | No equivalent; Tier_1 sorts to identity |
| `disk` | Local SSD (creation only; count fixed on `-lssd` types), Persistent Disk, Hyperdisk with provisioned IOPS and throughput. All inside the Compute Engine API, attachable to a running VM. Hyperdisk retunes once per four hours, so alternation is by a second disk, as with EBS | Fits. The own-API test still says requirement |
| File fixtures | Linux's | Unchanged |

Three things Compute Engine has that `aws.ec2` never needed:

- **Live migration.** `scheduling.onHostMaintenance` defaults to `MIGRATE`, so a Run can be moved between hosts mid-measurement, with "a decrease in performance in disk, CPU, memory, and network" and a clock jump of up to five seconds. A bundle constant of `TERMINATE`, read back from the API and from metadata `instance/scheduling/on-host-maintenance`, is #19's `rebootMigration` pattern over again. E2 cannot change the setting, so there the evidence is recorded instead: `instance/maintenance-event`, `virtual-clock/drift-token` before and after, and the `compute.instances.migrateOnHostMaintenance` audit event. In-place hypervisor updates have no signal at all, which puts them with neighbours on a shared host.
- **No visible host.** `resourceStatus.physicalHost` is hidden on most VMs, and whether a reboot keeps the host is not documented. `between_visits: keep` keeps the instance, not provably the host, so #18's "a Series that lived on one host for a year is distinguishable from one that moved daily" does not carry.
- **A busier image.** The guest agent steps the clock, rewrites I/O schedulers at boot, and manages users; stock Debian runs `unattended-upgrades` daily. All of it goes on the bundle's stop list, after the agent has installed the SSH key.

### The controller path

- **Reaching the box.** A Cloud Run job with Direct VPC egress reaches a VM's internal IP on port 22 and may run for 168 hours. The idle timers are misfit 3.
- **"No internet route" needs rewording per Kind.** Private Google Access requires a route whose next hop is `default-internet-gateway`, though "packets sent from VMs in your VPC network to Google APIs and services remain within Google's network". On Compute Engine the rule is no external IP.
- **The SSH key** goes in the instance's `ssh-keys` metadata and the guest agent writes `authorized_keys`. It is not cloud-init on Debian, as far as the documentation says. An organization policy that turns on OS Login makes the agent ignore the key silently.
- **The image pin fits, and is simpler.** Images are global, so one exact name (of the form `debian-12-bookworm-vYYYYMMDD`, in project `debian-cloud`) replaces the per-Region AMI table. The optional `image` identity field takes `projects/debian-cloud/global/images/family/debian-12`: the provider's own family path, the same everywhere, independent of the account, which is #18's definition word for word. Two observers: metadata `instance/image`, and `sourceImage` with `sourceImageId` on the boot disk. A superseded image becomes `DEPRECATED` and still launches by exact name. Google publishes no date for making one `OBSOLETE`, so a pin can be withdrawn under us; copying the image into our project guards against that and keeps `sourceImageId`. There is no content hash, as with AMIs.
- **The resolve job cannot `apt install podman`.** Stock Debian points at the Debian CDN, which Private Google Access does not reach. `packages.cloud.google.com` and `*.pkg.dev` are reachable, so the choices are an Artifact Registry remote repository (in preview) or pushing the runtime over SSH. A bundle matter.

### The `requires` facts

| `aws.ec2` fact | Compute Engine |
|---|---|
| `catalog_memory_mib` | `memoryMb`, so `catalog_memory_mb`. Google writes MB and means MiB ("these units represent binary gibibytes (GiB) and mebibytes (MiB)"), so the name repeats the provider's label and the fact's registered unit says MiB |
| `kernel_usable_memory_kb`, `kernel_physical_cores`, `kernel_cpus_online` | Identical. `kernel_physical_cores` loses its second observer: the catalog has `guestCpus` only |
| `catalog_instance_store_gb` | The catalog has a count, `bundledLocalSsds.partitionCount`, and no capacity |
| `catalog_ebs_baseline_throughput_mb_per_s` | Documentation tables only |
| `catalog_network_baseline_gbps`, `catalog_network_peak_gbps` | Documentation tables only ("generally 2 Gbps per vCPU") |

The two prefixes still say where a number comes from. The catalog is just thin: a zonal record of vCPUs, memory, disk-count limits, accelerators, and architecture, with no bandwidth, no disk performance limits, and no core count. The consequence is that #19's device for a Service Variant, requiring a vantage that cannot be the bottleneck, has nothing to name on Compute Engine. Proposed: a number that exists only in a documentation table is not a fact, and no third prefix is added for it.

### The Capture

- **The catalog section has a counterpart**, the `machineTypes.get` record.
- **Nothing in the processor or kernel sections is provider-specific**, with one AWS-shaped assumption: the kernel section lists "every NVMe device". On first- and second-generation series a Persistent Disk attaches over SCSI. It should read every block device.
- The guest reports the base frequency whatever the processor is doing, which only touches lines the mask already removes.

## `cloudflare.r2`, bullet by bullet

### Identity and slug

Required `location` and `storage_class`; optional `jurisdiction`, where absent means `default`. Slug `cloudflare.r2/weur/STANDARD_IA`.

- **Two spellings for one thing.** The S3-compatible API says `STANDARD_IA`; Cloudflare's own API says `InfrequentAccess`. #18's tie-break is "the account-independent one", and both are. Proposed: identity takes the spelling its observer reads. Class is per object on R2, and the object is read through the S3 API, so `STANDARD_IA`. The other spelling names the bucket's default class, a different thing.
- **The place is a hint.** There are six values (`wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`) and nothing finer. "Location Hints are a best effort and not a guarantee." Only Cloudflare's own API reports where the bucket is, in the bucket object's `location`; the S3 API answers `auto` to every such question. This is the silicon draw again on a Service: ask in the provider's word, read back where it landed, reject and retry. Two traps for the Provisioner. With no hint the bucket lands near the caller, which is the controller. And "Location Hints are only honored the first time a bucket with a given name is created", so a retry needs a new bucket name.
- **Per-account names.** The endpoint is `https://<account id>.r2.cloudflarestorage.com`, so the account is in every URL the binary is handed and in every `request_sent` event. That is consistent with #18, where outputs carry the provider's own identifiers and the account is an environment fact. Identity is untouched.
- **A jurisdiction is guaranteed and fixed at creation**, and has an endpoint of its own. It sorts to an optional identity field cleanly.

### The registry

| `aws.s3` entry | On R2 | Verdict |
|---|---|---|
| `region`, `bucket_type`, `location_name` observers | `location` and `jurisdiction` from Cloudflare's `GET bucket`, which needs an admin token | Fits. The controller holds the token, never the binary |
| `storage_class` observer | Whether `HeadObject` returns `x-amz-storage-class` is not documented; `ListObjectsV2` does show `StorageClass` | Fits, with a one-request check, as #29 left for directory buckets |
| `access` | Temporary credentials scoped to a bucket, prefixes, and exact keys, valid up to seven days. One permission covers every path, so `read_write` makes the Fixture writable too | Fits ADR-0027's directory-bucket case: caught after the Run, not prevented. No API reads a credential's scope back, so the probe is the observer, as on AWS |
| `access` probes | Work as specified. R2 allows one write per second per key, so each probe needs a fresh key | Fits; a bundle constant |
| `object_size`, `object_sha256` | Unchanged | Fits |
| `object_crc32c` | R2 offers CRC32C as `COMPOSITE` only. `FULL_OBJECT` exists only for `CRC64NVME` | Does not carry. #29's "CRC32C is the one algorithm that is full-object on every bucket type at every size" is true of S3 only. R2's attestation key is `object_crc64nvme`, which is misfit 1 on the Service side |
| `object_sse` | The request header is marked not implemented; encryption at rest is always on | The key is absent. The binary's PUT header is misfit 1 |
| `write_prefix`, the two-prefix layout, the listing, the lifecycle rule | All supported. Expired objects go "typically ... within 24 hours" | Fits |
| Versioning read-back | R2 has no versioning | Dismissed |
| Outputs | One `url`; no regional, zonal, or interface variants. The SigV4 region is `auto`, which the binary must be told | Fits per Kind; the output names are misfit 1 |

Two things R2 has that `aws.s3` never needed:

- **Local Uploads**, a per-bucket switch that writes near the client and copies to the bucket's location afterwards; Cloudflare reports "up to 75% reduction in Time to Last Byte" on cross-region uploads. By #18's sort it is changeable on a live bucket, so it is a state key, alternatable, with the API as its observer.
- **Caches nobody outside can see.** Every request enters a gateway at the Cloudflare edge nearest the client, and reads may come from a tiered read cache that Cloudflare's launch post says applies "whether you're using the S3 API, Workers Bindings, or plain HTTP". (Its consistency page says S3 API requests "do not transit through the cache", which appears to mean the CDN cache; the two are never reconciled.) #19 already has the answer and it needs no change: nothing is declared, and whatever the edge says about itself rides in `response_headers` verbatim, as CloudFront's `x-cache` does.

Two notes for the harness client: R2 does not answer `Expect: 100-continue`, and the TLS and HTTP versions on the S3 endpoint are not documented, so `connection_secured` is the record.

### `native`, `requires`, the Capture

None applies. A Service Kind binds no profile, registers no facts, and takes no Capture.

### The controller path

Every R2 Station crosses providers. The controller needs Cloudflare credentials and a route out to Cloudflare's API (misfit 3's note). The box needs a way out (misfit 2). Run credentials last up to seven days, so the one-hour role-chaining bound from #19 does not arise.

## Smaller rulings

Each has a proposed answer. None needs a ticket.

1. **`pins_silicon` moves from the Kind to the Target.** A Machine Target that binds no `profile` accepts only level Variants. (Misfit 4.)
2. **An option that selects the silicon is identity**, whatever its price line. A rule ahead of step 3 of #18's sort. (Misfit 4.)
3. **Custom machine types are not Targets** until someone wants one measured and the catalog record is confirmed to exist.
4. **Two APIs, two spellings:** identity takes the spelling its observer reads.
5. **A number found only in a documentation table is not a fact.** No third prefix.
6. **The Capture's kernel section lists every block device**, not every NVMe device. A correction to #22's text, for [Assemble the spec in docs/spec/](https://github.com/smrdotgg/ledgermath/issues/23).
7. **A provider renaming a live offering splits its Series.** Correct by ADR-0016. Whether the data interface shows the two as one is a line for [Open data interface](https://github.com/smrdotgg/ledgermath/issues/21).

## Not walked

- `hetzner.cloud`: no zones, no image versions (a pin would be a snapshot of ours), no processor named by the API, and nowhere inside the provider to run a controller task. It would stress the image pin and the controller harder than Compute Engine does, and the silicon question not at all.
- `gcp.storage`: would have tested a Service's private path from inside its own provider, which the `s3_route` discussion under misfit 2 covers from the Machine side.

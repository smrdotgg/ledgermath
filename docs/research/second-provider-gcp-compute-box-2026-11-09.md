# Second provider check: does the EC2 benchmark-box design survive Google Compute Engine?

Date: 2026-11-09

## Scope

This note checks the EC2 runner design against Compute Engine (GCE), on paper only. The design: a pinned image, no public IP, no internet route, and a controller in the same VPC that drives the box over SSH. The controller sets and reads back kernel and platform state, starts the benchmark, then stays silent on the SSH connection (keepalives off) until the binary exits. Ten questions, in this order: CPU feature controls; power and clock; live migration; disks; private API access; packages; the controller and connection tracking; SSH keys and first boot; the metadata server; burst and bandwidth.

## Source policy

Primary sources only: docs.cloud.google.com (cloud.google.com redirects there), the Compute Engine REST reference, and docs.aws.amazon.com for the one AWS contrast. Each page was fetched raw with curl and rendered to text with w3m on 2026-11-09, so quotes are page text, not tool summaries. The only edits are joining renderer-wrapped lines and marking cuts with "…". The pages' "Last updated" dates run from 2026-10-15 to 2026-11-09. WebSearch was used only to find URLs. **NOT FOUND** means "not located within a 3–4 fetch budget", not "false".

## Answers at a glance

1. **advancedMachineFeatures.** The Instance resource has six fields: `enableNestedVirtualization`, `threadsPerCore` (1 or 2), `visibleCoreCount`, `enableUefiNetworking`, `performanceMonitoringUnit` (`ARCHITECTURAL`/`STANDARD`/`ENHANCED`, A4X, C4A, C4 and M4 only) and `turboMode` (only `ALL_CORE_MAX`, C4 and C4N only). `instances.get` returns them as a top-level object. SMT and visible cores need a stop or restart, PMU needs a restart, and when turbo mode can change is undocumented. https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
2. **Power and clock.** Google states "Compute Engine instances don't provide any facilities for customer control of P-states". Only C4/C4N and a few large C2, C2D and M2 shapes get MWAIT C-state hints, and the guest sees only the base frequency. Whether cpufreq or cpuidle sysfs exists in a guest is undocumented, and so is in-guest SMT control. The only explicit clocksource guidance is SAP HANA's "required OS clocksource is TSC". https://docs.cloud.google.com/compute/docs/cpu-platforms
3. **Live migration.** VMs default to `MIGRATE` with `automaticRestart` true. E2, Spot and preemptible VMs, and non-migratable types (bare metal, GPU, H4D, RDMA, most Confidential VMs) cannot change it. Signals: `instance/maintenance-event` (60 s ahead, but only if polled), `virtual-clock/drift-token` afterwards, the `compute.instances.migrateOnHostMaintenance` audit event, and `resourceStatus.upcomingMaintenance`. `resourceStatus.physicalHost` exists but is hidden on most VMs. Google warns of brief disk, CPU, memory and network slowdowns and a clock jump of up to 5 s. https://docs.cloud.google.com/compute/docs/metadata/getting-live-migration-notice
4. **Disks.** Local SSD comes in 375 GiB devices (Titanium SSD is larger) and can only be added at create time; some types fix the count. Data survives a guest reboot but is lost on a stop unless you opt to preserve it. Disks are created and attached through the Compute Engine API itself (`disks.insert`, `instances.attachDisk`), including to running VMs. Hyperdisk performance can be retuned only every 4–6 h, and C4, C4A and N4 support no Persistent Disk at all. On third-generation series and later every disk is NVMe, and `/dev/disk/by-id/google-local-nvme-ssd-N` marks the local SSDs. https://docs.cloud.google.com/compute/docs/disks/disk-symlinks
5. **Google APIs without an external IP.** Private Google Access is the subnet field `privateIpGoogleAccess`, and it still needs routes whose next hop is `default-internet-gateway`. The VIPs are private.googleapis.com 199.36.153.8/30 and restricted.googleapis.com 199.36.153.4/30. A PSC endpoint is a global forwarding rule on your own internal IP, named `storage-ENDPOINT.p.googleapis.com` or reached as `storage.googleapis.com` through your own DNS zone. `storage.googleapis.com` works on every path; a VM with an external IP reaches Google APIs from that IP, staying on Google's network. https://docs.cloud.google.com/vpc/docs/configure-private-google-access
6. **Packages without internet.** Stock Debian points APT at the Debian CDN, which is not on the Private Google Access domain list. `packages.cloud.google.com` and `*.pkg.dev` (Artifact Registry) are on it, and Artifact Registry Apt remote repositories can proxy `deb.debian.org` and `archive.ubuntu.com` (preview). https://docs.cloud.google.com/artifact-registry/docs/repositories/remote-overview
7. **The controller.** A Cloud Run job reaches a VM's internal IP through Direct VPC egress or a connector, and tasks can run up to 168 h. But Cloud Run times out outbound VPC connections after 10 idle minutes. Separately, VPC networks "drop idle TCP connections after ten minutes. You can't change this limit"; Google's fix is TCP keepalives. AWS is configurable from 60 to 432000 s, with a default of 432000 s, but **350 s on Nitro v6**. https://docs.cloud.google.com/vpc/docs/quota
8. **SSH keys and first boot.** The guest agent turns the `ssh-keys` metadata entry (`user:ssh-rsa …`) into a local user and an `authorized_keys` file, and ignores metadata keys when OS Login is on. `startup-script` runs once the network is up; every public image ships the guest environment. Ubuntu and Container-Optimized OS use cloud-init (COS reads `user-data`), and Debian's cloud-init status is undocumented. https://docs.cloud.google.com/compute/docs/images/guest-agent-functions
9. **Metadata server.** `instance/scheduling/` gives `on-host-maintenance`, `automatic-restart` and `preemptible`. There is also `maintenance-event` (plus `upcoming-maintenance` on some series), `disks/` (device-name, index, interface, mode, type) and `network-interfaces/`. No key exposes `advancedMachineFeatures` or tenancy. https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
10. **Burst and bandwidth.** e2-micro, e2-small and e2-medium burst automatically from a token bucket (30, 60 and 120 s at 100%), with no on/off option found. Egress is "generally 2 Gbps per vCPU", listed per machine type, and includes PD and Hyperdisk traffic. Tier_1 (50–200 Gbps) is chosen via `networkPerformanceConfig.totalEgressBandwidthTier`, and no field exposes the numbers. https://docs.cloud.google.com/compute/docs/network-bandwidth

## 1. advancedMachineFeatures

- Quote: "\"advancedMachineFeatures\": { \"enableNestedVirtualization\": boolean, \"threadsPerCore\": integer, \"visibleCoreCount\": integer, \"enableUefiNetworking\": boolean, \"performanceMonitoringUnit\": enum, \"turboMode\": string },"
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: These six fields sit at the top level of the Instance resource, so `instances.get` returns them. The beta API has the same six.

- Quote: "To disable simultaneous multithreading (SMT) set this to 1. If unset, the maximum number of threads supported per core by the underlying processor is assumed."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: `threadsPerCore` takes 1 or 2.

- Quote: "You cannot set the number of threads per core on VMs for the following machine types: All C4A machine types All H4D machine types All H3 machine types All N4A machine types All Tau T2A machine types All Tau T2D machine types Machine types that have fewer than 2 vCPUs … Shared-core machine types"
- URL: https://docs.cloud.google.com/compute/docs/instances/set-threads-per-core
- Gloss: Arm series, H3/H4D, and small or shared-core shapes have no SMT switch.

- Quote: "PUT https://compute.googleapis.com/compute/v1/projects/PROJECT_ID/zones/ZONE/instances/VM_NAME?most_disruptive_allowed_action=RESTART"
- URL: https://docs.cloud.google.com/compute/docs/instances/set-threads-per-core
- Gloss: Changing SMT on an existing VM needs a restart; the console path says to stop the VM first.

- Quote: "You cannot customize the number of visible CPU cores while a VM is in the RUNNING state."
- URL: https://docs.cloud.google.com/compute/docs/instances/customize-visible-cores
- Gloss: `visibleCoreCount` can only be set at create time or while stopped, and not at all on bare metal.

- Quote: "C4 instances and C4N instances are able to run at all-core-max turbo frequency by setting the AdvancedMachineFeature field to ALL_CORE_MAX. If this field is unset, the instance runs at the default setting, which is unrestricted frequency. The ALL_CORE_MAX setting isn't available with C4D or C4A compute instances."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: `turboMode` has a single value. When it can change after creation: **NOT FOUND**.

- Quote: "Architectural (ARCHITECTURAL) … Standard (STANDARD): you can measure all events from the Architectural PMU type and any local events inside the CPU core … Enhanced (ENHANCED): … any local events outside the CPU core, including level 3 (L3) cache events."
- URL: https://docs.cloud.google.com/compute/docs/pmu-overview
- Gloss: C4A and A4X allow ARCHITECTURAL and STANDARD. ENHANCED needs a 144- or 288-vCPU C4, or certain M4 types.

- Quote: "You don't have to stop the compute instance to enable the PMU. However, to make the change effective, you must restart the compute instance"
- URL: https://docs.cloud.google.com/compute/docs/enable-pmu-in-vms
- Gloss: PMU is opt-in and restart-gated, unlike full-size EC2 instances.

- Quote: "You can't use the following VMs: E2 VMs Memory-optimized VMs VMs powered by ARM processors VMs powered by AMD processors except N4D"
- URL: https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview
- Gloss: These are excluded from nested virtualization. On supported VMs it is set at create time or through `instances.update`.

- Quote: "Whether to enable UEFI networking for instance creation."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: That is the entire doc for `enableUefiNetworking`. Supported series and change rules: **NOT FOUND**.

## 2. Power and clock controls inside a guest

- Quote: "A compute instance's guest environment reflects the base frequency, regardless of what frequency the CPU is actually running at."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: The guest-reported MHz is not the real clock. The same page adds: "Most compute instances get the all-core turbo frequency".

- Quote: "All C4 and C4N machine types, and certain C2 (30, 60 vCPUs), C2D (56, 112 vCPUs) and M2 (208, 416 vCPUs) machine types support instance-provided C-state hints by way of the MWAIT instruction. Compute Engine instances don't provide any facilities for customer control of P-states."
- URL: https://docs.cloud.google.com/compute/docs/cpu-platforms
- Gloss: This is the only C-state or P-state statement. Whether governors, cpuidle states or a boost file appear in sysfs: **NOT FOUND**.

- Quote: "Bare metal instances provide direct access to the host server's CPU and memory, without Compute Engine's hypervisor in the middle. Bare metal instances also expose all CPU performance counters"
- URL: https://docs.cloud.google.com/compute/docs/instances/bare-metal-instances
- Gloss: Bare metal exists on C3, C4, C4A, C4D, Z3 and others. Power-state docs for bare metal: **NOT FOUND**.

- Quote: "For bare metal instances, the number of hyperthreads you have access to is equivalent to the number of hyperthreads on the machine."
- URL: https://docs.cloud.google.com/compute/docs/instances/set-threads-per-core
- Gloss: Bare metal has no API SMT switch. In-guest SMT control: **NOT FOUND**.

- Quote: "For SAP HANA on Compute Engine instances, the required OS clocksource is TSC, which is the default setting for SLES and RHEL images."
- URL: https://docs.cloud.google.com/sap/docs/sap-hana-planning-guide
- Gloss: This is the only explicit guidance. Custom images must enable "CONFIG_KVM_CLOCK=y" (building-custom-os). A general recommendation: **NOT FOUND**.

- Quote: "the guest agent uses the clock_skew_daemon component to periodically correct the clock on your instance to match the physical server it runs on. … /sbin/hwclock --hctosys -u --noadjfile."
- URL: https://docs.cloud.google.com/compute/docs/images/guest-agent-functions
- Gloss: A Google daemon steps the guest clock, including after migration. An optional chrony + `ptp_kvm` setup targets "accuracy within 1 ms" (time-synchronization/configure-time-sync).

## 3. Live migration and host maintenance

- Quote: "For standard instances, the default behavior is MIGRATE. For preemptible instances, the default and only possible behavior is TERMINATE."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: `scheduling.onHostMaintenance` defaults to MIGRATE. `automaticRestart` defaults to true: "By default, this is set to true".

- Quote: "it's the only supported setting for H4D instances, Z3 instances with more than 18,000 GiB of attached Titanium SSD, Z4D and Z4M instances with more than 42,000 GiB of attached Titanium SSD, instances that have a Cloud RDMA network interface, bare metal instances, and instances with GPUs or TPUs attached."
- URL: https://docs.cloud.google.com/compute/docs/instances/setting-vm-host-options
- Gloss: These types are TERMINATE-only. Most Confidential VMs also cannot migrate (except N2D/C3D on SEV).

- Quote: "You can't change the maintenance behavior (onHostMaintenance) of the following types of instances: VMs that use E2 machine types. Spot VMs or preemptible VMs. Instances that don't support live migration."
- URL: https://docs.cloud.google.com/compute/docs/instances/setting-vm-host-options
- Gloss: Other VMs change it with `instances.setScheduling`. Whether that is allowed while RUNNING is never stated: **NOT FOUND**.

- Quote: "The value of this metadata key changes 60 seconds before a maintenance event starts … If you have never queried the maintenance-event metadata key or have not queried the metadata key since the last migration, … The maintenance event initiates immediately and skips the 60-second warning."
- URL: https://docs.cloud.google.com/compute/docs/metadata/getting-live-migration-notice
- Gloss: The warning exists only if the guest has polled this exact key.

- Quote: "At the start of the migration event, the value changes from NONE to MIGRATE_ON_HOST_MAINTENANCE. … Throughout the duration of the event … the value remains as MIGRATE_ON_HOST_MAINTENANCE. After the maintenance event ends, the value returns to NONE."
- URL: https://docs.cloud.google.com/compute/docs/metadata/getting-live-migration-notice
- Gloss: The key covers about-to-migrate and migrating; `?wait_for_change=true` blocks until it changes.

- Quote: "For sole-tenant VMs, during a host maintenance event, the maintenance-event metadata key value doesn't change and remains NONE"
- URL: https://docs.cloud.google.com/compute/docs/metadata/getting-live-migration-notice
- Gloss: Sole-tenant VMs get no signal.

- Quote: "The accumulated drift of the VM clock. Initialized to zero during instance creation and increased by the accumulated clock skew as the VM live migrates."
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: Reading `instance/virtual-clock/drift-token` before and after a run can show a migration happened (inference from this description).

- Quote: "For instances configured to use live migration during maintenance events, a system event with methodName: \"compute.instances.migrateOnHostMaintenance\"."
- URL: https://docs.cloud.google.com/compute/docs/instances/monitor-plan-host-maintenance-event
- Gloss: The audit log records the migration. `resourceStatus.upcomingMaintenance` shows scheduled disruptive work, "a minimum of 7 days notice for most instances".

- Quote: "Compute Engine also applies some lightweight hypervisor and network upgrades in the background non-disruptively by retaining the instance on the same host."
- URL: https://docs.cloud.google.com/compute/docs/instances/host-maintenance-overview
- Gloss: In-place host updates happen with no documented signal.

- Quote: "During blackout events, the system clock appears to jump forward, up to 5 seconds. … During live migration, VMs might experience a decrease in performance in disk, CPU, memory, and network utilization for a short period of time."
- URL: https://docs.cloud.google.com/compute/docs/instances/live-migration-process
- Gloss: Google's own statement of the performance cost. Large Local SSD footprints lengthen the degradation.

- Quote: "Output only. The precise location of your instance within the zone's data center, including the block, sub-block, and host. The field is formatted as follows: blockId/subBlockId/hostId."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/instances
- Gloss: This is `resourceStatus.physicalHost`. `scheduling.exposeHostTopology` "exposes the hashed physical host ID".

- Quote: "To expose the host ID for a compute instance, you must contact your account team or the sales team to request access to this feature."
- URL: https://docs.cloud.google.com/compute/docs/instances/view-instance-topology
- Gloss: Without that, the host ID is visible only for A3, A4 and A4X GPU types, H4D, compact placement, or HIGH_THROUGHPUT MIGs. The guest reads it at `attributes/physical_host_topology`.

- Quote: "The instance is either restarted on the same host server, or moved to another server in the same zone …"
- URL: https://docs.cloud.google.com/compute/docs/instances/host-maintenance-overview
- Gloss: Automatic restarts may change host. Whether a reboot or `instances.reset` keeps the host, and whether stop/start moves it: **NOT FOUND**.

## 4. Disks

- Quote: "Each Local SSD disk attached to an instance provides 375 GiB of capacity. … You can use either the NVMe or SCSI interface to mount Local SSD disks."
- URL: https://docs.cloud.google.com/compute/docs/disks/local-ssd
- Gloss: Titanium SSD (C4, C4A, C4D, Z3 and others) uses larger disks, from 3,000 to 14,000 GiB per series.

- Quote: "Some machine types always include a fixed number of Local SSD disks by default, while others allow you to add specific numbers of disks. You can only add Local SSD disks when you create the instance."
- URL: https://docs.cloud.google.com/compute/docs/disks/local-ssd
- Gloss: For example, c4-standard-16-lssd always comes with 2 disks.

- Quote: "Compute Engine preserves the data on Local SSD disks in the following events: You reboot the guest operating system (OS). You configure your instance for live migration and the instance goes through a host maintenance event. You opt to preserve the Local SSD data when you stop or suspend the instance (Preview)."
- URL: https://docs.cloud.google.com/compute/docs/disks/local-ssd
- Gloss: Data is lost on "You shut down the guest OS and force the instance to stop."

- Quote: "Balanced Persistent Disk (pd-balanced) SSD (Performance) Persistent Disk (pd-ssd) Standard Persistent Disk (pd-standard) Extreme Persistent Disk (pd-extreme)"
- URL: https://docs.cloud.google.com/compute/docs/disks/persistent-disks
- Gloss: The support table shows C4, C4A, N4, N4A and N4D with no PD type, so they are Hyperdisk-only.

- Quote: "Hyperdisk Balanced 160,000 IOPS 2,400 MiB/s … Hyperdisk Balanced High Availability 100,000 IOPS 2,400 MiB/s … Hyperdisk Extreme 350,000 IOPS … Hyperdisk ML 2,097,152 MiB/s … Hyperdisk Throughput 2,400 MiB/s"
- URL: https://docs.cloud.google.com/compute/docs/disks/hyperdisk-performance
- Gloss: These are per-volume maximums. The range also depends on size: a "50 GiB volume, you can provision 3,000 to 25,000 IOPS."

- Quote: "Modifications to provisioned IOPS or throughput: … For Hyperdisk ML: once every 6 hours For all other Hyperdisk types: once every 4 hours"
- URL: https://docs.cloud.google.com/compute/docs/disks/modify-hyperdisks
- Gloss: You cannot retune performance between consecutive runs.

- Quote: "After you create the disk, attach it to any running or stopped VM."
- URL: https://docs.cloud.google.com/compute/docs/disks/add-persistent-disk
- Gloss: Both steps use the Compute Engine API itself: `POST …/disks` (`disks.insert`) and `POST …/instances/VM_NAME/attachDisk`.

- Quote: "Compute instances based on third generation machine series or later use NVMe for both Persistent Disk and Google Cloud Hyperdisk, and also Local SSD disks. Each VM has 1 NVMe controller for Persistent Disk and Hyperdisk and 1 NVMe controller for each Local SSD disk."
- URL: https://docs.cloud.google.com/compute/docs/disks/set-persistent-device-name-in-linux-vm
- Gloss: Older series attach PD over SCSI. NVMe device order "is not predictable or consistent across instance restarts".

- Quote: "NVMe: The symlinks are named google-local-nvme-ssd-N, where N is the SSD number, starting from 0."
- URL: https://docs.cloud.google.com/compute/docs/disks/disk-symlinks
- Gloss: PD and Hyperdisk symlinks are `google-DEVICE_NAME`, the instance name for the boot disk, or `google-DISK_NAME`. SCSI Local SSD is `google-local-ssd-N`. The prefix is the documented way to tell local SSD from persistent disk.

- Quote: "Compute Engine creates additional symlinks in the directory based on the disk type and interface, for example scsi-0Google_PersistentDisk_DEVICE_NAME."
- URL: https://docs.cloud.google.com/compute/docs/disks/disk-symlinks
- Gloss: An example shows NVMe PD as "Model: nvme_card-pd (nvme)" (modify-hyperdisks). Local SSD model strings and serials: **NOT FOUND**.

- Quote: "Optimize for local SSD Configured using system IO scheduler settings in /sys/block/dev/queue/scheduler … On every startup (Linux only)"
- URL: https://docs.cloud.google.com/compute/docs/images/guest-agent-functions
- Gloss: The guest agent rewrites I/O schedulers at boot, so read them back after it runs.

## 5. Reaching Google APIs and Cloud Storage without an external IP

- Quote: "Whether the VMs in this subnet can access Google services without assigned external IP addresses. This field can be both set at resource creation time and updated using setPrivateIpGoogleAccess."
- URL: https://docs.cloud.google.com/compute/docs/reference/rest/v1/subnetworks
- Gloss: An observer checks `subnetworks.get` → `privateIpGoogleAccess`.

- Quote: "Your VPC network must have appropriate routes whose next hops are the default internet gateway. Google Cloud does not support routing traffic to Google APIs and services through other VM instances or custom next hops. Despite being called default internet gateway, packets sent from VMs in your VPC network to Google APIs and services remain within Google's network."
- URL: https://docs.cloud.google.com/vpc/docs/configure-private-google-access
- Gloss: A "no internet route" VPC still needs 0.0.0.0/0, or Google-range routes, pointing at `default-internet-gateway`. Check with `routes.list`.

- Quote: "private.googleapis.com • 199.36.153.8/30 … restricted.googleapis.com • 199.36.153.4/30"
- URL: https://docs.cloud.google.com/vpc/docs/configure-private-google-access
- Gloss: Both VIPs also need 34.126.0.0/18. Default domains use public Google IPs and need no DNS change.

- Quote: "In the googleapis.com zone, create a CNAME record for *.googleapis.com that points to the domain that you've configured: private.googleapis.com or restricted.googleapis.com."
- URL: https://docs.cloud.google.com/vpc/docs/configure-private-google-access
- Gloss: With a VIP, the name `storage.googleapis.com` keeps working through a private zone.

- Quote: "With Private Service Connect, you can create private endpoints using global internal IP addresses within your VPC network. You can assign DNS names to these internal IP addresses with meaningful names like storage-vialink1.p.googleapis.com"
- URL: https://docs.cloud.google.com/vpc/docs/about-accessing-google-apis-endpoints
- Gloss: The endpoint IP must be outside all subnet ranges.

- Quote: "You can create DNS records by using the default DNS names if you are using a client that hasn't been configured to use a custom endpoint … For example, create DNS records for *.googleapis.com or *.pkg.dev."
- URL: https://docs.cloud.google.com/vpc/docs/configure-private-service-connect-apis
- Gloss: An observer runs `gcloud compute forwarding-rules list --filter target="(all-apis OR vpc-sc)" --global`. VMs without an external IP still need the subnet's PGA flag on.

- Quote: "Though the connection is made from the VM's external IP address, the traffic stays within Google Cloud and is not sent through the public internet."
- URL: https://docs.cloud.google.com/vpc/docs/access-apis-external-ip
- Gloss: This is the path for a VM with an external IP: "Private Google Access has no effect on instances that have external IP addresses".

## 6. Packages without internet

- Quote: "The APT sources are set to use the Debian CDN. The Unattended-upgrades package is installed and configured to download and install Debian security updates daily."
- URL: https://docs.cloud.google.com/compute/docs/images/os-details
- Gloss: Stock Debian needs the internet and patches itself daily. Ubuntu uses "the Ubuntu Compute Engine mirrors via cloud-init"; whether those are reachable over PGA: **NOT FOUND**.

- Quote: "• packages.cloud.google.com • pkg.dev or *.pkg.dev"
- URL: https://docs.cloud.google.com/vpc/docs/configure-private-google-access
- Gloss: Both are on the private.googleapis.com list; deb.debian.org and archive.ubuntu.com are not. So `apt install podman` from stock sources should fail without NAT (inference).

- Quote: "Access to OS packages when VMs do not have external internet access or when public repositories have a service outage."
- URL: https://docs.cloud.google.com/compute/docs/instances/artifact-registry-os-packages
- Gloss: Google's documented answer is Artifact Registry Apt and Yum repositories.

- Quote: "Debian http://deb.debian.org DEBIAN Ubuntu LTS or Pro http://archive.ubuntu.com UBUNTU"
- URL: https://docs.cloud.google.com/artifact-registry/docs/repositories/remote-overview
- Gloss: These are remote proxy presets, "OS packages (preview)". The VM needs `apt-transport-artifact-registry` from packages.cloud.google.com.

## 7. The controller

- Quote: "Cloud Run supports the following Direct VPC configurations: Services: Egress only Jobs: Egress only"
- URL: https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc
- Gloss: A job can open TCP 22 to a VM's internal IP, through Direct VPC egress or a Serverless VPC Access connector. The VM cannot call the job.

- Quote: "By default, each task runs for a maximum of 10 minutes: you can change this to a shorter time or a longer time up to 168 hours (7 days)."
- URL: https://docs.cloud.google.com/run/docs/configuring/task-timeout
- Gloss: The same page adds: "A task configured with a multi-hour timeout should be expected to be interrupted at least once".

- Quote: "Cloud Run jobs that run for more than 1 hour might experience connection breaks. These can occur during maintenance events that migrate the job from one machine to another."
- URL: https://docs.cloud.google.com/run/docs/configuring/vpc-direct-vpc
- Gloss: The controller itself migrates, with SIGTSTP 10 s before and SIGCONT after.

- Quote: "For Cloud Run services and jobs, there is a timeout after 10 minutes of idle time for requests from your container to VPC. For requests from your container to the internet, there is a timeout after 20 minutes of idle time."
- URL: https://docs.cloud.google.com/run/docs/container-contract
- Gloss: **This is a second 10-minute idle limit**, on the controller side, separate from the firewall's.

- Quote: "Services and Instances Maximum number of open connections 50,000 per instance per egress type Doesn't apply to Direct VPC egress traffic."
- URL: https://docs.cloud.google.com/run/quotas
- Gloss: No connection-count quota applies to Direct VPC egress. It is capped at 1 Gbps per instance.

- Quote: "If a connection is allowed between a source and a target (for an ingress rule) or between a target and a destination (for an egress rule), all response traffic is allowed as long as the firewall's connection tracking state is active. A firewall rule's tracking state is considered active if at least one packet is sent every 10 minutes."
- URL: https://docs.cloud.google.com/firewall/docs/firewalls
- Gloss: Return traffic needs a live conntrack entry.

- Quote: "Cloud Next Generation Firewall connection tracking table entries are removed after a flow has been idle for 10 minutes."
- URL: https://docs.cloud.google.com/compute/docs/troubleshooting/general-tips
- Gloss: After 10 idle minutes the entry is deleted. The page then prescribes `SO_KEEPALIVE` and `TCP_KEEPIDLE`/`TCP_KEEPINTVL`/`TCP_KEEPCNT`, with a 60 s example.

- Quote: "Maximum duration for idle TCP connections 10 minutes VPC networks automatically drop idle TCP connections after ten minutes. You can't change this limit, but you can use TCP keepalives to prevent connections to instances from becoming idle."
- URL: https://docs.cloud.google.com/vpc/docs/quota
- Gloss: **Not configurable.** The connection is "drop[ped]", with no direction named.

- Quote: "Cloud NGFW always checks for a firewall connection tracking table entry before it evaluates firewall rules."
- URL: https://docs.cloud.google.com/firewall/docs/firewall-policies-rule-details
- Gloss: Once the entry is gone, packets fall through to rule evaluation, where rules "apply to packets for a new connection" (eval-order page).

- Quote: "If the target resource is a network interface of a VM instance, the implied ingress action is deny. … For egress traffic, the implied action is allow."
- URL: https://docs.cloud.google.com/firewall/docs/firewall-policies-rule-eval-order
- Gloss: That is all the docs say per direction. After expiry, VM→controller packets meet egress rules and controller→VM packets meet ingress rules. Whether a mid-stream segment is re-admitted as a "new connection": **NOT FOUND**.

- Quote: "TCP established timeout: Timeout (in seconds) for idle TCP connections in an established state. Min: 60 seconds Max: 432000 seconds Default: 350 seconds for Nitro v6 instance types (excluding P6e-GB200); 432000 seconds for all other instance types (including P6e-GB200)."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/security-group-connection-tracking.html
- Gloss: For contrast, AWS lets you configure this per ENI or at launch. A CIDR-scoped SSH rule is tracked ("Inbound and outbound TCP traffic on port 22 (SSH) is tracked"), so **Nitro v6's 350 s default already threatens the EC2 design.**

## 8. SSH keys and first boot

- Quote: "When you add SSH keys to metadata, the agent creates an authorized_keys file for the user account."
- URL: https://docs.cloud.google.com/compute/docs/images/guest-agent-functions
- Gloss: The agent's `accounts_daemon` creates the user and grants sudo through `google-sudoers`.

- Quote: "If you are managing SSH keys using metadata, this attribute lets you configure public SSH keys … Example: \"user1:ssh-rsa mypublickey user1@host.com\nuser2:ssh-rsa mypublickey user2@host.com\""
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: Pass `ssh-keys` in instance metadata at `instances.insert`. Set `block-project-ssh-keys` to ignore project-wide keys.

- Quote: "If OS Login is enabled for a VM, then the VM's guest agent ignores the keys stored in metadata."
- URL: https://docs.cloud.google.com/compute/docs/connect/add-ssh-keys
- Gloss: An org policy that enables OS Login silently breaks key injection. Keys written straight into `authorized_keys` "might be overwritten by the VM's guest agent".

- Quote: "startup scripts only run when a network is available."
- URL: https://docs.cloud.google.com/compute/docs/instances/startup-scripts/linux
- Gloss: The same page says "All public Compute Engine images come with the guest environment preinstalled."

- Quote: "Container-Optimized OS images include cloud-init … The cloud-init tool expects its configuration in the value of the user-data key of the instance metadata."
- URL: https://docs.cloud.google.com/container-optimized-os/docs/how-to/create-configure-instance
- Gloss: Ubuntu "uses cloud-init to do some boot time initialization" (os-details). Whether Debian honours `user-data`: **NOT FOUND**.

## 9. Metadata server

- Quote: "scheduling/ • on-host-maintenance: indicates whether the VM terminates or live migrates during host maintenance. • automatic-restart: … • preemptible: …"
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: The guest can read its own maintenance policy.

- Quote: "maintenance-event Indicates whether a maintenance event is affecting this VM."
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: Values: NONE, MIGRATE_ON_HOST_MAINTENANCE, TERMINATE_ON_HOST_MAINTENANCE. Some series also expose `upcoming-maintenance`, and the server "might briefly return a 503" during events.

- Quote: "A directory of disks that are attached to the VM. For each disk, the following information is available: • device-name • index • interface • mode • type"
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: Maps to the `google-DEVICE_NAME` symlinks.

- Quote: "network-interfaces/ … • ip: The assigned internal IP address for this network interface. … • mtu: The MTU for this network interface."
- URL: https://docs.cloud.google.com/compute/docs/metadata/predefined-metadata-keys
- Gloss: Also has access-configs/0/external-ip, gateway, mac and ip-aliases/, and the page lists `cpu-platform` and `machine-type`. A key for `advancedMachineFeatures` or tenancy: **NOT FOUND**; use `instances.get` or `lscpu`.

## 10. Burst and bandwidth

- Quote: "Bursting happens automatically when your VM requires more physical CPU than originally allocated. During these spikes, each vCPU can burst up to 100% of CPU time, for short periods"
- URL: https://docs.cloud.google.com/compute/docs/general-purpose-machines
- Gloss: There is no `standard`/`unlimited` analogue; a toggle: **NOT FOUND**. "Bursting doesn't incur any additional charges".

- Quote: "e2-micro: 30 seconds • e2-small: 60 seconds • e2-medium 120 seconds The exact burst time is determined by a Token bucket"
- URL: https://docs.cloud.google.com/compute/docs/general-purpose-machines
- Gloss: E2 runs fractional vCPUs of 0.25, 0.5 or 1.0 with 2 vCPUs exposed. f1-micro and g1-small run 0.2 or 0.5 with 1 vCPU exposed.

- Quote: "Per-instance maximum egress bandwidth is generally 2 Gbps per vCPU, but there are some differences and exceptions, depending on the machine series."
- URL: https://docs.cloud.google.com/compute/docs/network-bandwidth
- Gloss: Per-type numbers live on the machine family pages, and "Per-instance maximum egress bandwidth is not a guarantee."

- Quote: "The egress bandwidth includes data transferred to all Persistent Disk and Google Cloud Hyperdisk volumes attached to the instance."
- URL: https://docs.cloud.google.com/compute/docs/networking/configure-vm-with-high-bandwidth-configuration
- Gloss: Disk I/O and network share one cap, unlike EBS bandwidth on EC2.

- Quote: "Tier_1 networking increases the maximum egress bandwidth limit for compute instances. The maximum egress bandwidth limit ranges from 50 Gbps to 200 Gbps"
- URL: https://docs.cloud.google.com/compute/docs/networking/configure-vm-with-high-bandwidth-configuration
- Gloss: Requires gVNIC and specific series, and "you must stop and restart the instance" to change it. The only API field is `networkPerformanceConfig.totalEgressBandwidthTier`; a field with the Gbps numbers: **NOT FOUND**.

## Surprises for an EC2-shaped design

1. **The silent SSH session dies at 10 minutes, twice over.** The VPC firewall drops idle TCP after 10 minutes and you can't change it. Cloud Run separately times out idle connections into the VPC at 10 minutes. Google's documented remedy is kernel TCP keepalives, which send no application data. On AWS, Nitro v6 now defaults to 350 s, so the current design is already exposed there too.
2. **Live migration is on by default.** A run can see brownout, a blackout of up to 5 s and a clock jump. The 60 s notice comes only if the guest polled `maintenance-event`. Sole-tenant VMs get no signal, and in-place host updates have no signal at all. You can detect a migration afterwards via `virtual-clock/drift-token` or the audit log. E2 cannot opt out.
3. **No customer P-state control.** Turbo control exists only on C4/C4N (`ALL_CORE_MAX`), the guest sees the base frequency, and cpufreq/cpuidle in sysfs is undocumented.
4. **Changing SMT, visible cores, PMU or Tier_1 means a stop or restart.** There is no SMT switch on Arm or H3/H4D, and PMU is opt-in on four series.
5. **Private Google Access needs a `default-internet-gateway` route** even in a "no internet" VPC.
6. **Physical host IDs are hidden** unless Google enables `exposeHostTopology` or you use specific GPU or HPC shapes or compact placement.
7. **Disk I/O counts against the network egress cap.** C4, C4A and N4 have no Persistent Disk, and Hyperdisk can be retuned only every 4–6 h.
8. **Local SSD is create-time only**, the count is fixed on `-lssd` types, and data is wiped by a guest-initiated stop.
9. **Stock images add noise.** Debian and Ubuntu run daily unattended-upgrades. The guest agent rewrites I/O schedulers at boot, steps the clock, and manages users. Stock Debian APT cannot reach its mirror without NAT.
10. **Shared-core bursting cannot be disabled.**
11. **The controller host migrates too.** Cloud Run jobs over an hour may lose connections, and multi-hour tasks "should be expected to be interrupted at least once".

## NOT FOUND or contradictory

- `turboMode` change timing; `enableUefiNetworking` supported series and change rules.
- cpufreq, cpuidle or boost sysfs visibility in a guest; in-guest SMT control; bare-metal C-state and P-state control; a general clocksource recommendation outside SAP HANA.
- Whether `setScheduling` is allowed on a running VM.
- Whether a reboot or `instances.reset` keeps the host; whether stop/start moves it.
- Local SSD model strings and disk serial formats.
- Per-direction behaviour of an idle connection after conntrack expiry: is a mid-stream segment re-admitted as a "new connection"? The firewall page speaks of tracking state and response traffic, while the quota page says connections are "drop[ped]". Not contradictory, but neither gives direction-specific behaviour.
- Ubuntu Compute Engine mirror reachability over PGA; Debian `user-data` handling.
- Metadata keys for `advancedMachineFeatures` or tenancy; a shared-core burst toggle; an API field exposing egress Gbps.

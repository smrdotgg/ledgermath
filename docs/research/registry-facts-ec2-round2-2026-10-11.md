# LedgerMath research round 2: EC2 / AL2023 / kernel facts

Date: 2026-10-11. Primary sources only. Each finding gives (a) a verbatim quote, (b) the URL, (c) one line in my own words. Items I could not establish from a primary source are marked NOT FOUND.

Method notes:
- man7.org refused connections from this network for the whole session (ECONNREFUSED / timeout). The man pages below are quoted from the upstream Linux man-pages git repository on kernel.org (`git.kernel.org/pub/scm/docs/man-pages/man-pages.git`), which is the source man7.org renders. The man7.org URL is given alongside as the canonical rendered page.
- AWS pages were fetched raw and converted to text. The converter drops the space after inline `<code>` elements (e.g. "system-rebootevent"). Where that happened I restored the single space; no other words were changed.
- The AL2023 kernel configs in section 9 were read out of the actual kernel RPMs served by the AL2023 package CDN (`cdn.amazonlinux.com`), because neither docs.aws.amazon.com nor GitHub publishes them.

---

## 1. EC2 reboot versus stop/start

### 1(a) Reboot keeps host, instance store data, public IPv4

- Quote: "An instance reboot is equivalent to an operating system reboot. In most cases, it takes only a few minutes to reboot your instance." and "When you reboot an instance, it keeps the following: Public DNS name (IPv4) / Private IPv4 address / Public IPv4 address / IPv6 address (if applicable) / Any data on its instance store volumes"
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-reboot.html
- Gloss: reboot preserves addresses and ephemeral disk contents.

- Quote: "Rebooting an instance is equivalent to rebooting an operating system. The instance remains on the same host computer and maintains its public DNS name, private IP address, and any data on its instance store volumes. It typically takes a few minutes for the reboot to complete, but the time it takes to reboot depends on the instance configuration."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html (section "Rebooting instances")
- Gloss: the lifecycle page is the one that explicitly says "same host computer".

- Quote (comparison table, row "Host computer"): Reboot: "The instance stays on the same host computer." / Stop/start: "The instance is moved to a new host computer (though in some cases, it remains on the current host)." / Hibernate: same wording as stop/start / Terminate: "None"
- Quote (row "Public IPv4 address"): Reboot: "The instance keeps its public IPv4 address." / Stop/start: "The instance gets a new public IPv4 address, unless it has a secondary network interface or a secondary private IPv4 address that is associated with an Elastic IP address."
- Quote (row "Instance store volumes"): Reboot: "The data is preserved" / Stop/start: "The data is erased" / Hibernate: "The data is erased" / Terminate: "The data is erased"
- Quote (row "RAM (contents of memory)"): Reboot: "The RAM is erased" / Stop/start: "The RAM is erased" / Hibernate: "The RAM is saved to a file on the root volume"
- Quote (row "Billing"): Reboot: "The instance billing hour doesn't change" / Stop/start: "You stop incurring charges for an instance as soon as its state changes to stopping. Each time an instance transitions from stopped to running, we start a new instance billing period, billing a minimum of one minute every time you start your instance."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html#lifecycle-differences
- Gloss: the table is the single authoritative side-by-side.

### 1(b) Stop/start may move host, loses instance store, may change public IPv4

- Quote: "You can stop and start your instance if it has an Amazon EBS volume as its root volume. When you stop an instance, it shuts down. When you start an instance, it is typically migrated to a new underlying host computer and assigned a new public IPv4 address."
- Quote (Warning): "When you stop an instance, the data on any instance store volumes is erased. Before you stop an instance, verify that you've copied any data that you need from the instance store volumes to persistent storage, such as Amazon EBS or Amazon S3."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Stop_Start.html
- Gloss: "typically" migrated; not guaranteed either way.

- Quote: "When you start your instance, it enters the pending state, and the instance is moved to a new host computer (though in some cases, it remains on the current host). When you stop and start your instance, you lose any data on the instance store volumes attached to the previous host computer." and "Your instance retains its private IPv4 address, which means that an Elastic IP address associated with the private IPv4 address or network interface remains associated with your instance. If your instance has an IPv6 address, it retains the IPv6 address."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html#instance-stop-start
- Gloss: private IPv4/IPv6/EIP survive a stop; the auto-assigned public IPv4 does not.

- Quote ("What happens when you start an instance"): "In most cases, the instance is migrated to a new underlying host computer (though in some cases, such as when an instance is allocated to a host in a Dedicated Host configuration, it remains on the current host)." and "Amazon EC2 assigns a new public IPv4 address to the instance if the instance is configured to receive a public IPv4 address, unless it has a secondary network interface or a secondary private IPv4 address that is associated with an Elastic IP address."
- Quote ("Resources lost"): "Data stored on the RAM. / Data stored on the instance store volumes. / The public IPv4 address that Amazon EC2 automatically assigned to the instance upon launch or start. To retain a public IPv4 address that never changes, you can associate an Elastic IP address with your instance."
- Quote ("Resources that persist"): "Any attached Amazon EBS root and data volumes. / Data stored on the Amazon EBS volumes. / Any attached network interfaces."
- Quote (stop mechanics): "The API request sends a button press event to the guest." ... "If the instance OS does not cleanly shut down within a few minutes, a hard shutdown is performed."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/how-ec2-instance-stop-start-works.html
- Gloss: the one named case where a stop/start stays on the same host is Dedicated Host placement.

### 1(c) Does `LaunchTime` change?

- Quote (stop/start): "When you describe an instance, the launch time for the instance is its most recent launch time. After you stop and start an instance, the launch time reflects the new instance start time. To find the initial launch time for an instance, even after stopping and starting it, view the time at which the primary network interface was attached to the instance."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/Stop_Start.html#find-initial-launch-time
- Gloss: stop/start resets `LaunchTime`; the primary ENI `Attachment.AttachTime` is the stable "first launch" time.

- Quote (API field `launchTime` on the `Instance` type): "The time that the instance was last launched. To determine the time that instance was first launched, see the attachment time for the primary network interface."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Instance.html
- Gloss: the API describes it as "last launched", consistent with the user guide.

- Reboot: NOT FOUND. Neither the reboot page, the lifecycle page, nor the `Instance.launchTime` description states whether a reboot changes `LaunchTime`. The reboot page's "it keeps the following" list does not mention launch time either way.

### 1(d) Hard reboot behaviour of RebootInstances

- Quote: "Requests a reboot of the specified instances. This operation is asynchronous; it only queues a request to reboot the specified instances. The operation succeeds if the instances are valid and belong to you. Requests to reboot terminated instances are ignored." and "If an instance does not cleanly shut down within a few minutes, Amazon EC2 performs a hard reboot."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RebootInstances.html
- Gloss: the API gives no exact number, only "a few minutes".

- Quote: "For user-initiated reboots, we recommend using the Amazon EC2 console, CLI, or API instead of running the operating system reboot command from your instance. When using Amazon EC2, if the instance does not cleanly shut down within a few minutes, Amazon EC2 performs a hard reboot. Furthermore, AWS CloudTrail creates an API record of when your instance was rebooted."
- Quote (Important box): "When you use the Amazon EC2 console or the command line to reboot or shut down your instance, there is a risk that your instance will be hard rebooted. A hard reboot while updates are being installed could throw your instance into an unstable state."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-reboot.html
- Gloss: AWS prefers the API path over in-guest `reboot` and acknowledges the hard-reboot risk.

### 1(e) Reboot migration

- Quote: "When AWS must perform tasks such as installing updates or maintaining the underlying host, it can schedule an instance reboot. During the scheduled reboot, the instance either stays on the same host, or migrates to a different host, depending on the event, as follows: instance-reboot event — During the reboot, the instance remains on the host. This is known as an in-place reboot. The current host undergoes maintenance. Typically completes in seconds. system-reboot event — During the reboot, the instance is migrated to a new host. This is known as a reboot migration. Typically completes in minutes."
- Quote: "If reboot migration is enabled on your instance, a user-initiated reboot attempts to migrate your instance to new hardware. If successful, the event is cleared. If unsuccessful, an in-place reboot occurs and the event remains scheduled."
- Quote: "A reboot with migration takes longer than an in-place reboot: In-place reboot: Approximately 30 seconds / Reboot with migration: Several minutes"
- Quote (Note): "Instances that receive a system-reboot event notification are enabled for user-initiated reboot migration by default."
- Quote: "The default configuration doesn't enable reboot migration for an unsupported instance."
- Quote (Limitations): "Reboot migration is not supported for instances with the following characteristics: Platform: Instances running natively on the Xen hypervisor / Instance size: metal instances / Tenancy: Dedicated Host. For Dedicated Hosts, use Dedicated Host Auto Recovery instead. / Storage: Instances with instance store volumes / Networking: Instances using an Elastic Fabric Adapter / Auto Scaling: Instances that are part of an Auto Scaling group"
- Quote ("After AWS reboots your instance", system-reboot): "The instance moves to a new host. / The instance retains its IP address and DNS name. / Any data on local instance store volumes is preserved."
- Quote (alternative): "Manually stop and start the instance to migrate it to a new host. This is not the same as manually rebooting the instance, where the instance stays on the same host."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/schedevents_actions_reboot.html
- Gloss: a user-initiated reboot can move the instance to a new host, but only when a `system-reboot` event is pending and the instance type is eligible; metal and instance-store instances are excluded.

- Quote (`InstanceMaintenanceOptions.rebootMigration`): "Specifies whether to attempt reboot migration during a user-initiated reboot of an instance that has a scheduled system-reboot event: default - Amazon EC2 attempts to migrate the instance to new hardware (reboot migration). If successful, the system-reboot event is cleared. If unsuccessful, an in-place reboot occurs and the event remains scheduled. disabled - Amazon EC2 keeps the instance on the same hardware (in-place reboot). The system-reboot event remains scheduled. This setting only applies to supported instances that have a scheduled reboot event." Valid Values: `disabled | default`.
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceMaintenanceOptions.html
- Gloss: `DescribeInstances` exposes this under `MaintenanceOptions.RebootMigration`; `ModifyInstanceMaintenanceOptions --reboot-migration disabled` pins in-place reboots.

- Quote (`InstanceTypeInfo.rebootMigrationSupport`): "Indicates whether reboot migration during a user-initiated reboot is supported for instances that have a scheduled system-reboot event." Valid Values: `unsupported | supported`.
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceTypeInfo.html
- Gloss: per-type capability flag; the user guide shows `describe-instance-types --filters Name=reboot-migration-support,Values=supported`.

---

## 2. Do sysfs and sysctl settings survive a reboot?

### 2(a) Kernel documentation

- Quote (kernel-parameters.txt): "sysctl.*=	[KNL] Set a sysctl parameter, right before loading the init process, as if the value was written to the respective /proc/sys/... file. Both '.' and '/' are recognized as separators. Unrecognized parameters and invalid values are reported in the kernel log. Sysctls registered later by a loaded module cannot be set this way."
- URL: https://www.kernel.org/doc/Documentation/admin-guide/kernel-parameters.txt (raw: https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/Documentation/admin-guide/kernel-parameters.txt)
- Gloss: the kernel's own boot-time mechanism for sysctl values is the `sysctl.` command-line prefix; it exists precisely because `/proc/sys` writes are runtime-only.

- Quote (Documentation/admin-guide/sysctl/index.rst): "Sysctl is a means of configuring certain aspects of the kernel at run-time, and the /proc/sys/ directory is there so that you don't even need special tools to do it!"
- URL: https://www.kernel.org/doc/Documentation/admin-guide/sysctl/index.rst
- Gloss: kernel.org frames `/proc/sys` as run-time configuration; it has no sentence of the form "values do not persist across reboots".

- Literal "not persistent across reboots" sentence on kernel.org: NOT FOUND. The kernel docs describe `/proc/sys` and sysfs as run-time interfaces and provide the `sysctl.*=` boot parameter; they do not spell out non-persistence.

### 2(b) sysctl.d(5) (systemd), the mechanism that makes values persist

- Quote (refpurpose): "Configure kernel parameters at boot"
- Quote: "At boot, systemd-sysctl.service(8) reads configuration files from the above directories to configure sysctl(8) kernel parameters."
- Quote: "The settings configured with sysctl.d files will be applied early on boot."
- Quote: "Many sysctl parameters only become available when certain kernel modules are loaded. Modules are usually loaded on demand, e.g. when certain hardware is plugged in or network brought up. This means that systemd-sysctl.service(8) which runs during early boot will not configure such parameters if they become available after it has run."
- URL (canonical rendered page, unreachable this session): https://man7.org/linux/man-pages/man5/sysctl.d.5.html ; source quoted from: https://raw.githubusercontent.com/systemd/systemd/main/man/sysctl.d.xml
- Gloss: persistence of `/proc/sys` values comes from a boot-time service (`systemd-sysctl.service`) re-applying `/etc/sysctl.d/*.conf`, not from the kernel.

### 2(c) Does AL2023 ship `tuned`?

- Quote (AL2023 all-packages list, release 2023.12.20260930): "tuned | src, noarch | 2.25.1-2.amzn2023.0.2 | Full Support | End of Support on 2029-06-30 | 2029-06-30" (also listed: `tuned-ppd`, `tuned-profiles-atomic`, `tuned-profiles-compat`, `tuned-profiles-cpu-partitioning`, ... 18 `tuned*` rows; and "sysfsutils | src, aarch64, x86_64 | Full Support | End of Support on 2029-06-30")
- URL: https://docs.aws.amazon.com/linux/al2023/release-notes/all-packages-AL2023.12.html
- Gloss: yes, today's AL2023 ships `tuned` 2.25.1.

- Quote (release notes 2023.8.20250707, "Core New Packages"): "kiwi-10.2.26-3.amzn2023 / tuna-0.19-4.amzn2023.0.1 / tuned-2.25.1-2.amzn2023.0.2"
- URL: https://docs.aws.amazon.com/linux/al2023/release-notes/relnotes-2023.8.20250707.html
- Gloss: `tuned` was absent from AL2023 at GA and was added as a new core package in July 2025; AMIs older than 2023.8 do not have it in their locked repo.

- Quote (GitHub, amazonlinux/amazon-linux-2023 issue #327, state open): title "[Package Request] - tuned"; body: "What package is missing from Amazon Linux 2023? ... tuned ... Is this package available in Amazon Linux 2? ... Yes it's part of AL2."
- URL: https://github.com/amazonlinux/amazon-linux-2023/issues/327
- Gloss: corroborates that `tuned` was originally removed relative to AL2. (In the current "Packages in Amazon Linux 2 not in Amazon Linux 2023" list only `tuned-gtk` remains: https://docs.aws.amazon.com/linux/al2023/release-notes/removed-AL2023.12-AL2.html)

### 2(d) How AL2023 sets the kernel command line

- Quote: "Ensure that the grubby package is installed. rpm -q grubby ... Configure your bootloader to add selinux=0 to the kernel command line. sudo grubby --update-kernel ALL --args selinux=0 ... Restart your system."
- URL: https://docs.aws.amazon.com/linux/al2023/ug/disable-option-selinux.html
- Gloss: the AL2023 user guide's documented way to add a kernel argument is `grubby --update-kernel ALL --args ...`.

- Quote: "Make the new kernel your default kernel: $ sudo grubby --set-default "/boot/vmlinuz-$version" ... Reboot your system"
- URL: https://docs.aws.amazon.com/linux/al2023/ug/kernel-update.html
- Gloss: default-kernel selection is also done through `grubby`.

- Quote (`/boot`): "This directory is home to files needed for AL2023 to boot such as the Linux kernel and initramfs. The content of this directory should only be manipulated using the tools provided with the OS." and "By default, bootable AL2023 images are configured with the EFI System partition being mounted at /boot/efi."
- URL: https://docs.aws.amazon.com/linux/al2023/ug/filesystem-slash-boot.html
- Gloss: AL2023 boots UEFI with `/boot/efi`; direct editing of boot files is discouraged.

- `/etc/default/grub` in the AL2023 user guide: NOT FOUND as a procedure. The only AL2023 mention is a GA-era known issue: "When upgrading an instance from AL2023 RC1 or earlier, in order to avoid a boot order issue, you will need to add the following to /etc/default/grub before upgrading in order to get the kernel update: GRUB_DEFAULT=saved GRUB_UPDATE_DEFAULT_KERNEL=true" — https://docs.aws.amazon.com/linux/al2023/release-notes/relnotes-2023.0.20230315.html

---

## 3. Graviton and SMT

### 3(a) Each Graviton vCPU is a physical core

- Quote: "Our x86 based EC instances in AWS EC2 execute two hardware threads per core, each thread representing a vCPU. Graviton processors can execute only one hardware thread, or vCPU, per physical core. The Linux kernel schedules tasks to cores first, then, when all physical cores are used, to hardware threads."
- URL: https://aws.github.io/graviton/perfrunbook/system-load-and-compute-headroom.html (rendered from github.com/aws/aws-graviton-getting-started, perfrunbook)
- Gloss: AWS's own runbook states one vCPU per physical core on Graviton.

- Quote (CPU options Considerations): "You can't modify the number of threads per core for T2, C7a, M7a, R7a, and Apple silicon Mac instances, and instances based on the AWS Graviton processor."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-optimize-cpu.html
- Gloss: there is no SMT toggle for Graviton because there is nothing to toggle.

- Quote (Supported CPU options table, columns "Instance type | Default vCPUs | Default CPU cores | Default threads per core | Valid CPU cores | Valid threads per core"): "c7g.large | 2 | 2 | 1 | 1, 2 | 1"
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/cpu-options-supported-instances-values.html
- Gloss: official per-type confirmation that c7g has 1 thread per core.

- Quote (Instance Types Guide, compute optimized, columns "Instance type | Memory (GiB) | Processor | vCPUs | CPU cores | Threads per core | Accelerators | Accelerator memory"): "c7g.large | 4.00 | AWS Graviton3 Processor | 2 | 2 | 1 | ✗ No | ✗ No" and "c7g.metal | 128.00 | AWS Graviton3 Processor | 64 | 64 | 1 | ✗ No | ✗ No"
- URL: https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html
- Gloss: same fact from the instance-types guide.

- Quote (README hardware table): "Frequency | 2500MHz | 2600MHz | 2800MHz (2700MHz for 48xlarge) | 3300MHz" and "Turbo supported | No | No | No | No" (columns Graviton2 / Graviton3 / Graviton4 / Graviton5)
- URL: https://github.com/aws/aws-graviton-getting-started/blob/main/README.md (raw: https://raw.githubusercontent.com/aws/aws-graviton-getting-started/main/README.md)
- Gloss: fixed base frequency, no turbo, across generations. The README does not itself contain a "vCPU is a physical core" sentence.

- The AWS whitepaper "AWS Graviton Performance Testing: Tips for ISVs" ("Every vCPU is a physical core ..."): NOT FOUND at a stable URL — both `docs.aws.amazon.com/whitepapers/latest/aws-graviton-performance-testing/what-is-aws-graviton.html` and the `en_us/` variant now redirect to https://aws.amazon.com/ec2/graviton/, which does not contain the sentence.

### 3(b) Kernel ABI: `/sys/devices/system/cpu/smt/{control,active}`

- Quote (verbatim entry):
  ```
  What:		/sys/devices/system/cpu/smt
  		/sys/devices/system/cpu/smt/active
  		/sys/devices/system/cpu/smt/control
  Date:		June 2018
  Contact:	Linux kernel mailing list <linux-kernel@vger.kernel.org>
  Description:	Control Symmetric Multi Threading (SMT)

  		active:  Tells whether SMT is active (enabled and siblings online)

  		control: Read/write interface to control SMT. Possible
  			 values:

  			 ================ =========================================
  			 "on"		  SMT is enabled
  			 "off"		  SMT is disabled
  			 "<N>"		  SMT is enabled with N threads per core.
  			 "forceoff"	  SMT is force disabled. Cannot be changed.
  			 "notsupported"   SMT is not supported by the CPU
  			 "notimplemented" SMT runtime toggling is not
  					  implemented for the architecture
  			 ================ =========================================

  			 If control status is "forceoff" or "notsupported" writes
  			 are rejected. Note that enabling SMT on PowerPC skips
  			 offline cores.
  ```
- URL: https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-devices-system-cpu
- Gloss: six possible `control` values; `active` is a 0/1.

### 3(c) What the two files read on arm64 without SMT (derived from kernel source; not observed on a live instance)

Kernel source facts (quoted):

- Quote (`include/linux/cpu_smt.h`, v6.12, `#else` branch for `!CONFIG_HOTPLUG_SMT`): "# define cpu_smt_control               (CPU_SMT_NOT_IMPLEMENTED)" / "# define cpu_smt_num_threads 1"
- URL: https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/linux/cpu_smt.h?h=v6.12 (in v6.1 the identical define lives in `include/linux/cpu.h`: https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/linux/cpu.h?h=v6.1, line 224 "# define cpu_smt_control		(CPU_SMT_NOT_IMPLEMENTED)")
- Gloss: when the kernel is built without `CONFIG_HOTPLUG_SMT`, the state is hard-wired to NOT_IMPLEMENTED.

- Quote (`kernel/cpu.c`, same in v6.1, v6.12, v6.15, master):
  ```
  static const char *smt_states[] = {
  	[CPU_SMT_ENABLED]		= "on",
  	[CPU_SMT_DISABLED]		= "off",
  	[CPU_SMT_FORCE_DISABLED]	= "forceoff",
  	[CPU_SMT_NOT_SUPPORTED]		= "notsupported",
  	[CPU_SMT_NOT_IMPLEMENTED]	= "notimplemented",
  };
  ```
  and `control_show()` returns `smt_states[cpu_smt_control]` (master adds: "If SMT is enabled but not all threads are enabled then show the number of threads. If all threads are enabled show "on". Otherwise show the state name."), and `active_show()` returns `sched_smt_active()`.
- Quote (`kernel/cpu.c` v6.1 lines 2544-2556 and v6.12/master equivalents): `cpu_smt_sysfs_init()` creates the "smt" attribute group and is called unconditionally from `cpuhp_sysfs_init()`; it sits outside the `#ifdef CONFIG_HOTPLUG_SMT` block (the `#else /* !CONFIG_HOTPLUG_SMT */` branch only replaces `__store_smt_control` with one that returns `-ENODEV`).
- URL: https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/kernel/cpu.c?h=v6.1 ; ...?h=v6.12 ; ...?h=v6.15
- Gloss: the `smt/` directory exists even without `CONFIG_HOTPLUG_SMT`; `control` then reads `notimplemented` and writes fail with ENODEV.

- Quote (`include/linux/sched/smt.h` v6.12): "#ifdef CONFIG_SCHED_SMT ... static __always_inline bool sched_smt_active(void) { return static_branch_likely(&sched_smt_present); } #else static inline bool sched_smt_active(void) { return false; } #endif"
- URL: https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/include/linux/sched/smt.h?h=v6.12
- Gloss: `active` reads `0` whenever `CONFIG_SCHED_SMT` is off, and also when no sibling threads are online.

- Quote (`kernel/cpu.c`, `cpu_smt_set_num_threads`, v6.12/v6.15/master): "The decision whether SMT is supported can only be done after the full CPU identification. Called from architecture code." ... "if (max_threads == 1) cpu_smt_control = CPU_SMT_NOT_SUPPORTED;" ... "If SMT has been disabled via the kernel command line or SMT is not supported, set cpu_smt_num_threads to 1 for consistency."
- Gloss: on a kernel that *does* have `CONFIG_HOTPLUG_SMT`, an architecture that reports 1 thread per core gets `notsupported`.

arm64 support timeline (quoted):

- Quote (`arch/arm64/Kconfig` v6.15, line 256): "	select HOTPLUG_SMT if HOTPLUG_CPU". The string `HOTPLUG_SMT` does not appear in `arch/arm64/Kconfig` at v6.1, v6.12 or v6.14 (0 matches in each).
- URLs: https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/arch/arm64/Kconfig?h=v6.15 (and `?h=v6.14`, `?h=v6.12`, `?h=v6.1`)
- Commits (all authored by Yicong Yang, committed by Catalin Marinas 2025-03-14, merged into mainline via "Merge branch 'for-next/smt-control' into for-next/core" 8ae9e2d8 and "Merge tag 'arm64-upstream'" 2d09a944 on 2025-03-25, i.e. the v6.15 merge window):
  - eed4583bcf9a60f8d6dd3a3c7c94dea28134b1eb "arm64: Kconfig: Enable HOTPLUG_SMT" — message: "Enable HOTPLUG_SMT for SMT control." Link: https://lore.kernel.org/r/20250311075143.61078-5-yangyicong@huawei.com — https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=eed4583bcf9a60f8d6dd3a3c7c94dea28134b1eb
  - e6b18ebfaf6360a357455507ae3e965989461c71 "arm64: topology: Support SMT control on ACPI based system" — https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=e6b18ebfaf6360a357455507ae3e965989461c71
  - 5deb9c789ae468a71a7c11c92d21769f7cbf68fa "arch_topology: Support SMT control for OF based system" — https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/commit/?id=5deb9c789ae468a71a7c11c92d21769f7cbf68fa
- Quote (`arch/arm64/kernel/topology.c` v6.15, `parse_acpi_topology`): "max_smt_thread_num = max(max_smt_thread_num, entry->thread_num);" ... "cpu_smt_set_num_threads(max_smt_thread_num, max_smt_thread_num);"
- URL: https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/arch/arm64/kernel/topology.c?h=v6.15
- Gloss: from v6.15, arm64 ACPI systems (which EC2 Graviton instances are) feed the PPTT thread count into the generic SMT control; a 1-thread-per-core system therefore gets `notsupported`.

Resulting expected reads (derived):

| Kernel on arm64, no SMT | `smt/control` | `smt/active` |
|---|---|---|
| v6.1 / v6.12 (no `CONFIG_HOTPLUG_SMT` on arm64; AL2023 aarch64 configs also have `# CONFIG_SCHED_SMT is not set`, see section 9) | `notimplemented` | `0` |
| v6.15+ with `CONFIG_HOTPLUG_SMT` (arm64 selects it) and PPTT reporting 1 thread/core | `notsupported` | `0` |

Observed output from a live Graviton instance: NOT FOUND in any primary source.

---

## 4. `DescribeInstanceTypes` / `InstanceTypeInfo` field descriptions

All quotes from https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceTypeInfo.html unless a nested-type URL is given.

`VCpuInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_VCpuInfo.html):
- `defaultVCpus`: "The default number of vCPUs for the instance type." (Integer)
- `defaultCores`: "The default number of cores for the instance type." (Integer)
- `defaultThreadsPerCore`: "The default number of threads per core for the instance type." (Integer)
- `ValidCores.N`: "The valid number of cores that can be configured for the instance type." (Array of integers)
- `ValidThreadsPerCore.N`: "The valid number of threads per core that can be configured for the instance type." (Array of integers)

`MemoryInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_MemoryInfo.html):
- `sizeInMiB`: "The size of the memory, in MiB." (Long)

Instance storage:
- `instanceStorageSupported`: "Indicates whether instance storage is supported." (Boolean)
- `InstanceStorageInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceStorageInfo.html): `totalSizeInGB`: "The total size of the disks, in GB." (Long) / `Disks.N`: "Describes the disks that are available for the instance type." / `nvmeSupport`: "Indicates whether non-volatile memory express (NVMe) is supported." Valid Values: `unsupported | supported | required` / `encryptionSupport`: "Indicates whether data is encrypted at rest." Valid Values: `unsupported | required`
- `DiskInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_DiskInfo.html): `sizeInGB`: "The size of the disk in GB." (Long) / `count`: "The number of disks with this configuration." (Integer) / `type`: "The type of disk." Valid Values: `hdd | ssd`

EBS:
- `EbsInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_EbsInfo.html): `ebsOptimizedSupport`: "Indicates whether the instance type is Amazon EBS-optimized." Valid Values: `unsupported | supported | default` / `ebsOptimizedInfo`: "Describes the optimized EBS performance for the instance type." / `nvmeSupport`: "Indicates whether non-volatile memory express (NVMe) is supported." Valid Values: `unsupported | supported | required` / `encryptionSupport`: "Indicates whether Amazon EBS encryption is supported." / `maximumEbsAttachments`: "Indicates the maximum number of Amazon EBS volumes that can be attached to the instance type." / `attachmentLimitType`: "Indicates whether the instance type features a shared or dedicated Amazon EBS volume attachment limit." Valid Values: `shared | dedicated`
- `EbsOptimizedInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_EbsOptimizedInfo.html): `baselineBandwidthInMbps`: "The baseline bandwidth performance for an EBS-optimized instance type, in Mbps." (Integer) / `baselineThroughputInMBps`: "The baseline throughput performance for an EBS-optimized instance type, in MB/s." (Double) / `baselineIops`: "The baseline input/output storage operations per seconds for an EBS-optimized instance type." (Integer) / `maximumBandwidthInMbps`: "The maximum bandwidth performance for an EBS-optimized instance type, in Mbps." (Integer) / `maximumThroughputInMBps`: "The maximum throughput performance for an EBS-optimized instance type, in MB/s." (Double) / `maximumIops`: "The maximum input/output storage operations per second for an EBS-optimized instance type." (Integer)

Network:
- `NetworkInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_NetworkInfo.html): `networkPerformance`: "The network performance." (String) / `NetworkCards.N`: "Describes the network cards for the instance type." / `enaSupport`: "Indicates whether Elastic Network Adapter (ENA) is supported." Valid Values: `unsupported | supported | required` / `efaSupported`: "Indicates whether Elastic Fabric Adapter (EFA) is supported." (Boolean) / `enaSrdSupported`: "Indicates whether the instance type supports ENA Express. ENA Express uses AWS Scalable Reliable Datagram (SRD) technology to increase the maximum bandwidth used per stream and minimize tail latency of network traffic between EC2 instances." / `encryptionInTransitSupported`: "Indicates whether the instance type automatically encrypts in-transit traffic between instances." / `maximumNetworkCards`: "The maximum number of physical network cards that can be allocated to the instance."
- `NetworkCardInfo` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_NetworkCardInfo.html): `baselineBandwidthInGbps`: "The baseline network performance of the network card, in Gbps." (Double) / `peakBandwidthInGbps`: "The peak (burst) network performance of the network card, in Gbps." (Double) / `networkCardIndex`: "The index of the network card." / `networkPerformance`: "The network performance of the network card." / `maximumNetworkInterfaces`: "The maximum number of network interfaces for the network card."

Processor (`ProcessorInfo`, https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ProcessorInfo.html):
- `SupportedArchitectures.N`: "The architectures supported by the instance type." Valid Values: `i386 | x86_64 | arm64 | x86_64_mac | arm64_mac`
- `sustainedClockSpeedInGhz`: "The speed of the processor, in GHz." (Double)
- `SupportedFeatures.N`: "Indicates whether the instance type supports AMD SEV-SNP. If the request returns amd-sev-snp, AMD SEV-SNP is supported. Otherwise, it is not supported." Valid Values: `amd-sev-snp | nested-virtualization`
- `manufacturer`: "The manufacturer of the processor." (String)

Top-level flags:
- `burstablePerformanceSupported`: "Indicates whether the instance type is a burstable performance T instance type."
- `bareMetal`: "Indicates whether the instance is a bare metal instance type."
- `hypervisor`: "The hypervisor for the instance type." Valid Values: `nitro | xen`
- `SupportedBootModes.N`: "The supported boot modes." Valid Values: `legacy-bios | uefi`
- `nitroEnclavesSupport`: "Indicates whether Nitro Enclaves is supported." Valid Values: `unsupported | supported`
- `nitroTpmSupport`: "Indicates whether NitroTPM is supported." Valid Values: `unsupported | supported` (plus `nitroTpmInfo`: "Describes the supported NitroTPM versions for the instance type.")
- `dedicatedHostsSupported`: "Indicates whether Dedicated Hosts are supported on the instance type."
- `placementGroupInfo` -> `PlacementGroupInfo.SupportedStrategies.N`: "The supported placement group types." Valid Values: `cluster | partition | spread` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_PlacementGroupInfo.html)
- `SupportedUsageClasses.N`: "Indicates whether the instance type is offered for spot, On-Demand, or Capacity Blocks." Valid Values: `spot | on-demand | capacity-block`
- `SupportedRootDeviceTypes.N`: "The supported root device types." Valid Values: `ebs | instance-store`
- `SupportedVirtualizationTypes.N`: "The supported virtualization types." Valid Values: `hvm | paravirtual`
- `currentGeneration`: "Indicates whether the instance type is current generation."
- `freeTierEligible`: "Indicates whether the instance type is eligible for the free tier."
- `autoRecoverySupported`: "Indicates whether Amazon CloudWatch action based recovery is supported."
- `phcSupport`: "Indicates whether a local Precision Time Protocol (PTP) hardware clock (PHC) is supported." Valid Values: `unsupported | supported`
- `rebootMigrationSupport`: "Indicates whether reboot migration during a user-initiated reboot is supported for instances that have a scheduled system-reboot event." Valid Values: `unsupported | supported`
- `hibernationSupported`: "Indicates whether On-Demand hibernation is supported."
- `supportedInRegion`: "Indicates whether the instance type is supported in the current Region."
- Gloss: note that `hypervisor` here distinguishes `nitro` from `xen`, unlike the `Instance.hypervisor` field (section 10).

Example output:
- Official full `describe-instance-types` output for c7g.large, c6i.metal or m7i.large: NOT FOUND. The only complete official example is `t2.micro` in the CLI reference (https://docs.aws.amazon.com/cli/latest/reference/ec2/describe-instance-types.html, "Example 1: To describe an instance type"), which shows `"BareMetal": false, "Hypervisor": "xen", "VCpuInfo": {"DefaultVCpus": 1, "DefaultCores": 1, "DefaultThreadsPerCore": 1, "ValidCores": [1], "ValidThreadsPerCore": [1]}, "MemoryInfo": {"SizeInMiB": 1024}, "InstanceStorageSupported": false, "EbsInfo": {"EbsOptimizedSupport": "unsupported", "EncryptionSupport": "supported"}, "NetworkInfo": {"NetworkPerformance": "Low to Moderate", ... "EnaSupport": "unsupported"}`.
- Official per-type values for the three target types do exist in tabular form:
  - Supported CPU options table (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/cpu-options-supported-instances-values.html), columns "Instance type | Default vCPUs | Default CPU cores | Default threads per core | Valid CPU cores | Valid threads per core": "m7i.large | 2 | 1 | 2 | 1 | 1, 2" and "c7g.large | 2 | 2 | 1 | 1, 2 | 1". c6i.metal is not in that table (bare metal does not support CPU options; see section 5).
  - Instance Types Guide (https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html), columns "Instance type | Memory (GiB) | Processor | vCPUs | CPU cores | Threads per core | Accelerators | Accelerator memory": "c6i.metal | 256.00 | Intel Xeon Ice Lake | 128 | 64 | 2 | ✗ No | ✗ No"; "c7g.large | 4.00 | AWS Graviton3 Processor | 2 | 2 | 1 | ✗ No | ✗ No". EBS table (columns "Instance type | Baseline / Maximum bandwidth (Mbps) | Baseline / Maximum throughput (MB/s, 128 KiB I/O) | Baseline / Maximum IOPS (16 KiB I/O) | NVMe | Multiple EBS cards | EBS volume limit"): "c6i.metal | 40000.00 | 5000.00 | 160000.00 | ✓ Yes | ✗ No | Up to 31 (Shared limit)"; "c7g.large 1 | 630.00 / 10000.00 | 78.75 / 1250.00 | 3600.00 / 40000.00 | ✓ Yes | ✗ No | Up to 27 (Shared limit)". Network table (columns "Instance type | Baseline / Burst bandwidth (Gbps) | EFA | ENA | ENA Express | ENA queues per interface (Default/Maximum) | Network cards | Max. network interfaces | IP addresses per interface | IPv6"): "c6i.metal 2 | 50 Gigabit | ✓ Yes | ✓ Yes | ✓ Yes | 8 | 1 | 15 | 50 | ✓ Yes"; "c7g.large 1 2 | 0.937 / 12.5 | ✗ No | ✓ Yes | ✗ No | 2 | 1 | 3 | 10 | ✓ Yes". Security table: "c6i.metal | ✓ Yes | Instance store not supported | ✓ Yes | ✗ No | ✗ No | ✗ No" and "c7g.large | ✓ Yes | Instance store not supported | ✓ Yes | ✗ No | ✓ Yes | ✓ Yes" (columns "EBS encryption | Instance store encryption | Encryption in transit | AMD SEV-SNP | NitroTPM | Nitro Enclaves").

---

## 5. `CpuOptions` at launch and after

- Quote (`CpuOptionsRequest`): `CoreCount`: "The number of CPU cores for the instance." (Integer) / `ThreadsPerCore`: "The number of threads per CPU core. To disable multithreading for the instance, specify a value of 1. Otherwise, specify the default value of 2." (Integer) / `AmdSevSnp`: "Indicates whether to enable the instance for AMD SEV-SNP. AMD SEV-SNP is supported with M6a, R6a, and C6a instance types only." / `NestedVirtualization`: "Indicates whether to enable the instance for nested virtualization. Nested virtualization is supported only on 8th generation Intel-based instance types (c8i, m8i, r8i, and their flex variants)."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CpuOptionsRequest.html
- Gloss: the API text frames `ThreadsPerCore` as 1 or "the default value of 2".

- Quote (`RunInstances` parameter `CpuOptions`): "The CPU options for the instance. For more information, see Optimize CPU options in the Amazon EC2 User Guide." Type: CpuOptionsRequest object. Required: No.
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RunInstances.html

- Quote (Rules page): "You can't specify CPU options for bare metal instances." / "You can specify CPU options both during and after instance launch." / "To configure CPU options, you must specify both the number of CPU cores and threads per core in the request." / "The number of vCPUs for the instance is the number of CPU cores multiplied by the threads per core. To specify a custom number of vCPUs, you must specify a valid number of CPU cores and threads per core for the instance type. You cannot exceed the default number of vCPUs for the instance." / "To disable simultaneous multithreading (SMT), also referred to as hyper-threading, specify one thread per core." / "The specified CPU options persist after you stop, start, or reboot an instance."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-cpu-options-rules.html
- Gloss: both fields are mandatory together; bare metal (c6i.metal) cannot use CPU options at all; the premise "cannot be changed after launch" is no longer what the docs say.

- Quote ("Change CPU options for your EC2 instance"): "You can change the number of vCPUs that run for an existing instance in the Amazon EC2 console, AWS CLI, API, or SDKs. The instance state must be Stopped before you can make this change." and "Use the modify-instance-cpu-options command and specify the number of CPU cores that run in the --core-count parameter, and the number of threads that run per core in the --threads-per-core parameter."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-specify-cpu-options.html
- Quote (`ModifyInstanceCpuOptions`): "By default, all vCPUs for the instance type are active when you launch an instance. When you configure the number of active vCPUs for the instance, it can help you save on licensing costs and optimize performance. The base cost of the instance remains unchanged. The number of active vCPUs equals the number of threads per CPU core multiplied by the number of cores. The instance must be in a Stopped state before you make changes." Parameters: `CoreCount` "The number of CPU cores to activate for the specified instance."; `ThreadsPerCore` "The number of threads to run for each CPU core."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_ModifyInstanceCpuOptions.html
- Gloss: CPU options are mutable, but only via a stop (which, per section 1, may move the instance to a new host).

- Quote (Graviton / families that cannot disable SMT): "You can't modify the number of threads per core for T2, C7a, M7a, R7a, and Apple silicon Mac instances, and instances based on the AWS Graviton processor." and the page intro: "Many Amazon EC2 instances support simultaneous multithreading (SMT), which enables multiple threads to run concurrently on a single CPU core. Each thread is represented as a virtual CPU (vCPU) on the instance. An instance has a default number of CPU cores, which varies according to instance type. For example, an m5.xlarge instance type has two CPU cores and two threads per core by default—four vCPUs in total."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-optimize-cpu.html
- Gloss: on Graviton the only valid `ThreadsPerCore` is 1 (table row "c7g.large | 2 | 2 | 1 | 1, 2 | 1"; https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/cpu-options-supported-instances-values.html). The per-family support list is the table on that page (e.g. "m7i.large | 2 | 1 | 2 | 1 | 1, 2"; "c6i.large | 2 | 1 | 2 | 1 | 1, 2").

- Quote (`DescribeInstances` -> `Instance.cpuOptions`): "The CPU options for the instance." Type: CpuOptions object. `CpuOptions` fields: `coreCount`: "The number of CPU cores for the instance." / `threadsPerCore`: "The number of threads per CPU core." / `amdSevSnp`: "Indicates whether the instance is enabled for AMD SEV-SNP." Valid Values: `enabled | disabled` / `nestedVirtualization`: "Indicates whether the instance is enabled for nested virtualization."
- URLs: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Instance.html ; https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CpuOptions.html
- Quote (View page): "aws ec2 describe-instances --instance-ids i-1234567890abcdef0 --query Reservations[].Instances[].CpuOptions ... The CoreCount field indicates the number of cores for the instance. The ThreadsPerCore field indicates the number of threads per core." Example output `{"CoreCount": 24, "ThreadsPerCore": 2}`.
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/view-cpu-options.html

---

## 6. EBS volume type constraints for `CreateVolume`

`CreateVolume` parameters (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_CreateVolume.html):

- `Iops`: "The number of I/O operations per second (IOPS) to provision for the volume. Required for io1 and io2 volumes. Optional for gp3 volumes. Omit for all other volume types. Valid ranges: gp3: 3,000 (default) - 80,000 IOPS / io1: 100 - 64,000 IOPS / io2: 100 - 256,000 IOPS. Note: Instances built on the Nitro System can support up to 256,000 IOPS. Other instances can support up to 32,000 IOPS." Type: Integer.
- `Throughput`: "The throughput to provision for the volume, in MiB/s. Supported for gp3 volumes only. Omit for all other volume types. Valid Range: 125 - 2000 MiB/s" Type: Integer.
- `Size`: "The size of the volume, in GiBs. You must specify either a snapshot ID or a volume size. If you specify a snapshot, the default is the snapshot size, and you can specify a volume size that is equal to or larger than the snapshot size. Valid sizes: gp2: 1 - 16,384 GiB / gp3: 1 - 65,536 GiB / io1: 4 - 16,384 GiB / io2: 4 - 65,536 GiB / st1 and sc1: 125 - 16,384 GiB / standard: 1 - 1024 GiB" Type: Integer.
- `VolumeType`: "The volume type. This parameter can be one of the following values: General Purpose SSD: gp2 | gp3 / Provisioned IOPS SSD: io1 | io2 / Throughput Optimized HDD: st1 / Cold HDD: sc1 / Magnetic: standard. Important: Throughput Optimized HDD (st1) and Cold HDD (sc1) volumes can't be used as boot volumes. ... Default: gp2" Valid Values: `standard | io1 | io2 | gp2 | sc1 | st1 | gp3`.
- Gloss: st1/sc1 accept neither `Iops` nor `Throughput` ("Omit for all other volume types"); `Throughput` is gp3-only; gp3 `Iops` is optional with a 3,000 default.

IOPS-per-GiB ceilings and type summaries (EBS User Guide):
- Quote (gp3): "gp3 volumes deliver a consistent baseline IOPS performance of 3,000 IOPS, which is included with the price of storage. You can provision additional IOPS (up to a maximum of 80,000) for an additional cost at a ratio of 500 IOPS per GiB of volume size. Maximum IOPS can be provisioned for volumes 160 GiB or larger (500 IOPS per GiB × 160 GiB = 80,000 IOPS)." and "gp3 volumes deliver a consistent baseline throughput performance of 125 MiB/s, which is included with the price of storage. You can provision additional throughput (up to a maximum of 2,000 MiB/s) for an additional cost at a ratio of 0.25 MiB/s per provisioned IOPS. Maximum throughput can be provisioned at 8,000 IOPS or higher and 16 GiB or larger (8,000 IOPS × 0.25 MiB/s per IOPS = 2,000 MiB/s)." and "gp3 volumes do not use burst performance. They can indefinitely sustain their full provisioned IOPS and throughput performance." and "A gp3 volume can range in size from 1 GiB to 64 TiB."
- URL: https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html
- Quote (io2 Block Express): "Storage capacity up to 64 TiB (65,536 GiB)." / "Provisioned IOPS up to 256,000, with an IOPS:GiB ratio of 1,000:1. Maximum IOPS can be provisioned with volumes 256 GiB and larger (1,000 IOPS × 256 GiB = 256,000 IOPS)." / "Volume throughput up to 4,000 MiB/s. Throughput scales proportionally at a rate of 0.256 MiB/s per provisioned IOPS. Maximum throughput can be achieved at 16,000 IOPS or higher." / "You can achieve up to 256,000 IOPS with Nitro-based instances. On other instances, you can achieve up to 32,000 IOPS."
- Quote (io1): "io1 volumes can range in size from 4 GiB to 16 TiB and you can provision from 100 IOPS up to 64,000 IOPS per volume. The maximum ratio of provisioned IOPS to requested volume size (in GiB) is 50:1."
- URL: https://docs.aws.amazon.com/ebs/latest/userguide/provisioned-iops.html
- Quote (st1/sc1 table): "Volume size | 125 GiB - 16 TiB" / "Max IOPS per volume (1 MiB I/O) | 500 | 250" / "Max throughput per volume | 500 MiB/s | 250 MiB/s" / "Boot volume | Not supported"; SSD table: "Volume size | 1 GiB - 64 TiB | 1 GiB - 16 TiB | 4 GiB - 64 TiB | 4 GiB - 16 TiB" (gp3 / gp2 / io2 Block Express / io1), "Max IOPS | 80,000 (25.6 KiB I/O) | 16,000 (16 KiB I/O) | 256,000 (16 KiB I/O) | 64,000 (16 KiB I/O)", "Max throughput | 2,000 MiB/s | 250 MiB/s | 4,000 MiB/s | 1,000 MiB/s".
- URL: https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html
- Quote (st1): "Throughput Optimized HDD (st1) volumes provide low-cost magnetic storage that defines performance in terms of throughput rather than IOPS. ... Bootable st1 volumes are not supported." / "For a 1-TiB st1 volume, burst throughput is limited to 250 MiB/s, the bucket fills with credits at 40 MiB/s, and it can hold up to 1 TiB-worth of credits." (sc1: "For a 1-TiB sc1 volume, burst throughput is limited to 80 MiB/s, the bucket fills with credits at 12 MiB/s")
- URL: https://docs.aws.amazon.com/ebs/latest/userguide/hdd-vols.html

Error for passing `Iops`/`Throughput` to a type that does not support them:
- Specific error text: NOT FOUND. Neither `CreateVolume` ("For information about the errors that are common to all actions, see Common Error Types.") nor the Common Error Types page names a volume-type/IOPS combination error. The generic client errors are: "InvalidParameterCombination | Indicates an incorrect combination of parameters, or a missing parameter. For example, trying to terminate an instance without specifying the instance ID." and "InvalidParameterValue | A value specified in a parameter is not valid, is unsupported, or cannot be used. Ensure that you specify a resource by using its full ID. The returned message provides an explanation of the error value." (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/errors-overview.html). Volume-related named errors on that page are `MaxIOPSLimitExceeded` ("You've reached the limit on your IOPS usage for the AWS Region.") and `VolumeIOPSLimit` ("The maximum IOPS limit for the volume has been reached.").

`DescribeVolumes` response (`Volume` type, https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Volume.html):
- `iops`: "The number of I/O operations per second (IOPS). For gp3, io1, and io2 volumes, this represents the number of IOPS that are provisioned for the volume. For gp2 volumes, this represents the baseline performance of the volume and the rate at which the volume accumulates I/O credits for bursting." (Integer)
- `throughput`: "The throughput that the volume supports, in MiB/s." (Integer)
- `size`: "The size of the volume, in GiBs." (Integer)
- `volumeType`: "The volume type." Valid Values: `standard | io1 | io2 | gp2 | sc1 | st1 | gp3`
- `volumeId`: "The ID of the volume." (String)
- `attachmentSet` -> `VolumeAttachment` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_VolumeAttachment.html): `device`: "The device name. If the volume is attached to an AWS-managed resource, this parameter returns null." / `instanceId`: "The ID of the instance." / `status`: "The attachment state of the volume." Valid Values: `attaching | attached | detaching | detached | busy` / `attachTime`: "The time stamp when the attachment initiated." / `deleteOnTermination`: "Indicates whether the EBS volume is deleted on instance termination." / `ebsCardIndex`: "The index of the EBS card. Some instance types support multiple EBS cards. The default EBS card index is 0."
- Gloss: `Attachments[].Device` is the requested device name (e.g. `/dev/sdf`), not the NVMe name the guest sees.

---

## 7. Page-cache observability from inside a process

### mincore(2)
- Quote: "mincore() returns a vector that indicates whether pages of the calling process's virtual memory are resident in core (RAM), and so will not cause a disk access (page fault) if referenced. The kernel returns residency information about the pages starting at the address addr, and continuing for length bytes."
- Quote: "On return, the least significant bit of each byte will be set if the corresponding page is currently resident in memory, and be clear otherwise. (The settings of the other bits in each byte are undefined; these bits are reserved for possible later use.) Of course the information returned in vec is only a snapshot: pages that are not locked in memory can come and go at any moment, and the contents of vec may already be stale by the time this call returns."
- URL: https://man7.org/linux/man-pages/man2/mincore.2.html (quoted from https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/man/man2/mincore.2)
- Gloss: a point-in-time residency bitmap, explicitly allowed to be stale on return.

### /proc/pid/io (proc_pid_io(5), split out of proc(5))
- Quote: "This file contains I/O statistics for the process and its waited-for children" ... "rchar: characters read — The number of bytes returned by successful read(2) and similar system calls." / "wchar: characters written — The number of bytes returned by successful write(2) and similar system calls." / "read_bytes: bytes read — The number of bytes really fetched from the storage layer. This is accurate for block-backed filesystems." / "write_bytes: bytes written — The number of bytes really sent to the storage layer." / "cancelled_write_bytes: The above statistics fail to account for truncation: if a process writes 1 MB to a regular file and then removes it, said 1 MB will not be written, but will have nevertheless been accounted as a 1 MB write. This field represents the number of bytes "saved" from I/O writeback. This can yield to having done negative I/O if caches dirtied by another process are truncated. cancelled_write_bytes applies to I/O already accounted-for in write_bytes."
- Quote (CAVEATS): "These counters are not atomic: on systems where 64-bit integer operations may tear, a counter could be updated simultaneously with a read, yielding an incorrect intermediate value."
- Quote: "Permission to access this file is governed by ptrace(2) access mode PTRACE_MODE_READ_FSCREDS."
- URL: https://man7.org/linux/man-pages/man5/proc_pid_io.5.html (quoted from https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/man/man5/proc_pid_io.5)
- Gloss: `read_bytes` counts actual storage-layer reads (page-cache misses), `rchar` counts syscall bytes regardless of cache.

### getrusage(2)
- Quote (struct comments): "long   ru_minflt;        /* page reclaims (soft page faults) */" / "long   ru_majflt;        /* page faults (hard page faults) */"
- Quote: "ru_minflt — The number of page faults serviced without any I/O activity; here, I/O activity is avoided by "reclaiming" a page frame from the list of pages awaiting reallocation." / "ru_majflt — The number of page faults serviced that required I/O activity."
- Quote: "RUSAGE_SELF — Return resource usage statistics for the calling process, which is the sum of resources used by all threads in the process." / "RUSAGE_CHILDREN — Return resource usage statistics for all children of the calling process that have terminated and been waited for." / "RUSAGE_THREAD is Linux-specific."
- URL: https://man7.org/linux/man-pages/man2/getrusage.2.html (quoted from https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/man/man2/getrusage.2)
- Gloss: a major fault is the per-process signal that a file page was not in cache.

### fincore(1) (util-linux)
- Quote: "fincore counts pages of file contents being resident in memory (in core), and reports the numbers. If an error occurs during counting, then an error message is printed to the stderr and fincore continues processing the rest of files listed in a command line."
- Quote: "fincore uses the cachestat(2) syscall to count resident pages. If the cachestat(2) syscall is not available and cachestat usage is not forced with the --cachestat option, then fincore uses the mincore(2) syscall as a fallback." / "The cachestat(2) syscall is more efficient than mincore because it does not require a page table lock to walks page tables, and also reports more information than mincore, like the number of cached pages, dirty pages, pages marked for writeback, evicted pages, and recently evicted pages." / "Another difference between the two syscalls is that if write permissions are not granted to the file, then cachestat(2) returns an error, while mincore(2) for security reasons, returns fake data as if all pages were resident in memory (c.f.r. kernel commit "make mincore() more conservative")."
- Quote: "The default output is subject to change. So whenever possible, you should avoid using default outputs in your scripts. Always explicitly define expected columns by using --output columns-list in environments where a stable output is required."
- URL: https://man7.org/linux/man-pages/man1/fincore.1.html (quoted from the man page source https://raw.githubusercontent.com/util-linux/util-linux/master/misc-utils/fincore.1.adoc)
- Column definitions (the man page does not list them; they are in the program source):
  - `"PAGES"` — "file data resident in memory in pages"
  - `"RES"` — "file data resident in memory in bytes"
  - `"SIZE"` — "size of the file"
  - `"FILE"` — "file name"
  - (also `DIRTY_PAGES`/`DIRTY`, `WRITEBACK_PAGES`/`WRITEBACK`, `EVICTED_PAGES`/`EVICTED`, `RECENTLY_EVICTED_PAGES`/`RECENTLY_EVICTED`)
  - URL: https://raw.githubusercontent.com/util-linux/util-linux/master/misc-utils/fincore.c (lines 111-122)
- Gloss: fincore is a thin wrapper over cachestat/mincore; the mincore fallback lies (all-resident) for files you cannot write.

### /proc/sys/vm/drop_caches (Documentation/admin-guide/sysctl/vm.rst), full section
- Quote:
  "Writing to this will cause the kernel to drop clean caches, as well as reclaimable slab objects like dentries and inodes.  Once dropped, their memory becomes free.

  To free pagecache: echo 1 > /proc/sys/vm/drop_caches
  To free reclaimable slab objects (includes dentries and inodes): echo 2 > /proc/sys/vm/drop_caches
  To free slab objects and pagecache: echo 3 > /proc/sys/vm/drop_caches

  This is a non-destructive operation and will not free any dirty objects. To increase the number of objects freed by this operation, the user may run `sync` prior to writing to /proc/sys/vm/drop_caches.  This will minimize the number of dirty objects on the system and create more candidates to be dropped.

  This file is not a means to control the growth of the various kernel caches (inodes, dentries, pagecache, etc...)  These objects are automatically reclaimed by the kernel when memory is needed elsewhere on the system.

  Use of this file can cause performance problems.  Since it discards cached objects, it may cost a significant amount of I/O and CPU to recreate the dropped objects, especially if they were under heavy use.  Because of this, use outside of a testing or debugging environment is not recommended.

  You may see informational messages in your kernel log when this file is used: cat (1234): drop_caches: 3

  These are informational only.  They do not mean that anything is wrong with your system.  To disable them, echo 4 (bit 2) into drop_caches."
- URL: https://www.kernel.org/doc/Documentation/admin-guide/sysctl/vm.rst (rendered: https://www.kernel.org/doc/html/latest/admin-guide/sysctl/vm.html#drop-caches)
- Gloss: dirty pages are never dropped; `sync` first. The exact phrase "not a replacement for ..." does not occur; the closest sentence is "This file is not a means to control the growth of the various kernel caches".

### posix_fadvise(2)
- Quote: "The advice is not binding; it merely constitutes an expectation on behalf of the application."
- Quote (WILLNEED): "POSIX_FADV_WILLNEED — The specified data will be accessed in the near future. POSIX_FADV_WILLNEED initiates a nonblocking read of the specified region into the page cache. The amount of data read may be decreased by the kernel depending on virtual memory load. (A few megabytes will usually be fully satisfied, and more is rarely useful.)"
- Quote (DONTNEED): "POSIX_FADV_DONTNEED — The specified data will not be accessed in the near future. POSIX_FADV_DONTNEED attempts to free cached pages associated with the specified region. This is useful, for example, while streaming large files. A program may periodically request the kernel to free cached data that has already been used, so that more useful cached pages are not discarded instead. Requests to discard partial pages are ignored. It is preferable to preserve needed data than discard unneeded data. If the application requires that data be considered for discarding, then offset and size must be page-aligned. The implementation may attempt to write back dirty pages in the specified region, but this is not guaranteed. Any unwritten dirty pages will not be freed. If the application wishes to ensure that dirty pages will be released, it should call fsync(2) or fdatasync(2) first."
- Quote (NOTES): "The contents of the kernel buffer cache can be cleared via the /proc/sys/vm/drop_caches interface described in proc(5). One can obtain a snapshot of which pages of a file are resident in the buffer cache by opening a file, mapping it with mmap(2), and then applying mincore(2) to the mapping."
- URL: https://man7.org/linux/man-pages/man2/posix_fadvise.2.html (quoted from https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/man/man2/posix_fadvise.2)
- Gloss: DONTNEED is best-effort, page-aligned, and skips dirty pages unless you fsync first; WILLNEED is a nonblocking prefetch that the kernel may truncate.

### readahead(2)
- Quote: "readahead() initiates readahead on a file so that subsequent reads from that file will be satisfied from the cache, and not block on disk I/O (assuming the readahead was initiated early enough and that other activity on the system did not in the meantime flush pages from the cache)." / "I/O is performed in whole pages, so that offset is effectively rounded down to a page boundary and bytes are read up to the next page boundary greater than or equal to (offset+count). readahead() does not read beyond the end of the file. The file offset of the open file description referred to by the file descriptor fd is left unchanged."
- Quote (BUGS): "readahead() attempts to schedule the reads in the background and return immediately. However, it may block while it reads the filesystem metadata needed to locate the requested blocks. This occurs frequently with ext[234] on large files using indirect blocks instead of extents, giving the appearance that the call blocks until the requested data has been read."
- URL: https://man7.org/linux/man-pages/man2/readahead.2.html (quoted from https://git.kernel.org/pub/scm/docs/man-pages/man-pages.git/plain/man/man2/readahead.2)
- Gloss: a page-granular prefetch that is "background" in intent but can block on metadata.

---

## 8. EC2 instance store volumes

### Lifetime
- Quote: "Instance store volumes are attached only at instance launch. You can't attach instance store volumes after launch. You can't detach an instance store volume from one instance and attach it to a different instance." / "An instance store volume exists only during the lifetime of the instance to which it is attached. You can't configure an instance store volume to persist beyond the lifetime of its associated instance." / "The data on an instance store volume persists even if the instance is rebooted. However, the data does not persist if the instance is stopped, hibernated, or terminated. When the instance is stopped, hibernated, or terminated, every block of the instance store volume is cryptographically erased."
- Quote (table "Event | What happens to your data?"): "The instance is rebooted | The data persists" / "The instance is stopped | The data does not persist" / "The instance is hibernated | The data does not persist" / "The instance is terminated | The data does not persist" / "The instance type is changed | The data does not persist *" / "A shutdown is initiated | The data does not persist †" / "A restart is initiated | The data persists" / "Instance stop | The data does not persist" / "Instance reboot | The data persists" / "System reboot | The data persists" / "Instance retirement | The data does not persist" / "Simplified automatic recovery | The data does not persist" / "CloudWatch action based recovery | The data does not persist" / "The underlying disk fails | The data on the failed disk does not persist" / "Power failure | The data persists upon reboot"
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-lifetime.html
- Gloss: reboot (user, OS, or AWS-scheduled, including system-reboot migration) keeps the data; any stop-class event erases it.

### NVMe instance store must be formatted and mounted by the user
- Quote: "For instance types with NVMe instance store volumes, all of the supported instance store volumes are automatically attached to the instance at launch. They are automatically enumerated and assigned a device name on instance launch." / "After you launch an instance, you must ensure that the instance store volumes for your instance are formatted and mounted before you can use them. The instance store root volume is mounted automatically."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/add-instance-store-volumes.html
- Quote: "Then, after the instance has launched, you must format and mount the attached instance store volumes before you can use them. You can't attach an instance store volume after you launch the instance."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-volumes.html
- Gloss: NVMe volumes appear automatically but unformatted.

### Encryption, NVMe driver, TRIM
- Quote: "The data on NVMe instance storage is encrypted using an XTS-AES-256 block cipher implemented in a hardware module on the instance. The encryption keys are generated using the hardware module and are unique to each NVMe instance storage device. All encryption keys are destroyed when the instance is stopped or terminated and cannot be recovered. You cannot disable this encryption and you cannot provide your own encryption key."
- Quote: "To access NVMe volumes, the NVMe drivers must be installed. The following AMIs meet this requirement: AL2023 / Amazon Linux 2 / ..." and "The NVMe volumes are compliant with the NVMe 1.0e specification. You can use the NVMe commands with your NVMe volumes. With Amazon Linux, you can install the nvme-cli package from the repo using the yum install command."
- Quote (TRIM): "Some instance types support SSD volumes with TRIM." / "Instance store volumes that support TRIM are fully trimmed before they are allocated to your instance. These volumes are not formatted with a file system when an instance launches, so you must format them before they can be mounted and used. For faster access to these volumes, you should skip the TRIM operation when you format them." / "With instance store volumes that support TRIM, you can use the TRIM command to notify the SSD controller when you no longer need data that you've written. This provides the controller with more free space, which can reduce write amplification and increase performance. On Linux instances, use the fstrim command to enable periodic TRIM."
- Quote (over-provisioning): "The SSD-based instance store volumes provided to an instance do not have any space reserved for over-provisioning. To reduce write amplification, we recommend that you leave 10 percent of the volume unpartitioned so that the SSD controller can use it for over-provisioning."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ssd-instance-store.html
- Gloss: fresh volumes arrive pre-trimmed; `mkfs` with discard skipped is the documented fast path.

### Initialization recommendation
- Quote: "Because of the way that Amazon EC2 virtualizes disks, the first write to any location on some instance store volumes performs more slowly than subsequent writes. For most applications, amortizing this cost over the lifetime of the instance is acceptable. However, if you require high disk performance, we recommend that you initialize your drives by writing once to every drive location before production use."
- Quote (Note): "Instance types with direct-attached solid state drives (SSD) and TRIM support provide maximum performance at launch time, without initialization."
- Quote: "Initialization can take a long time (about 8 hours for an extra large instance)."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/disk-performance.html
- Gloss: the initialization advice targets older non-TRIM volumes; NVMe SSD store with TRIM (c6id/m6id/c7gd/i4i) is documented as full-speed at launch.

### Sizes (Instance Types Guide; table columns "Instance type | Instance store volumes | Instance store type | 100% random read IOPS / Write IOPS | Needs initialization 1 | TRIM support 2")
- c7g: no instance store. Security table row: "c7g.large | ✓ Yes | Instance store not supported | ✓ Yes | ✗ No | ✓ Yes | ✓ Yes" (and `c7g.metal` likewise). The disk variant c7gd: "c7gd.medium | 1 x 59 GB | NVMe SSD | 16,771 / 8,385 | | ✓ Yes" / "c7gd.large | 1 x 118 GB | NVMe SSD | 33,542 / 16,771 | | ✓ Yes" / "c7gd.xlarge | 1 x 237 GB | NVMe SSD | 67,083 / 33,542 | | ✓ Yes" / "c7gd.2xlarge | 1 x 474 GB | NVMe SSD | 134,167 / 67,084 | | ✓ Yes" / "c7gd.4xlarge | 1 x 950 GB | NVMe SSD | 268,333 / 134,167 | | ✓ Yes" / "c7gd.8xlarge | 1 x 1900 GB | NVMe SSD | 536,666 / 268,334 | | ✓ Yes" / "c7gd.12xlarge | 2 x 1425 GB | NVMe SSD | 804,998 / 402,500 | | ✓ Yes" / "c7gd.16xlarge | 2 x 1900 GB | NVMe SSD | 1,073,332 / 536,668 | | ✓ Yes" / "c7gd.metal | 2 x 1900 GB | NVMe SSD | 1,073,332 / 536,668 | | ✓ Yes"
- c6id: "c6id.large | 1 x 118 GB | NVMe SSD | 33,542 / 16,771 | | ✓ Yes" / "c6id.xlarge | 1 x 237 GB" / "c6id.2xlarge | 1 x 474 GB" / "c6id.4xlarge | 1 x 950 GB" / "c6id.8xlarge | 1 x 1900 GB" / "c6id.12xlarge | 2 x 1425 GB" / "c6id.16xlarge | 2 x 1900 GB" / "c6id.24xlarge | 4 x 1425 GB" / "c6id.32xlarge | 4 x 1900 GB" / "c6id.metal | 4 x 1900 GB | NVMe SSD | 2,146,664 / 1,073,336 | | ✓ Yes"
- URL: https://docs.aws.amazon.com/ec2/latest/instancetypes/co.html
- m6id: "m6id.large | 1 x 118 GB | NVMe SSD | 33,542 / 16,771 | | ✓ Yes" / "m6id.xlarge | 1 x 237 GB" / "m6id.2xlarge | 1 x 474 GB" / "m6id.4xlarge | 1 x 950 GB" / "m6id.8xlarge | 1 x 1900 GB" / "m6id.12xlarge | 2 x 1425 GB" / "m6id.16xlarge | 2 x 1900 GB" / "m6id.24xlarge | 4 x 1425 GB" / "m6id.32xlarge | 4 x 1900 GB" / "m6id.metal | 4 x 1900 GB | NVMe SSD | 2,146,664 / 1,073,336 | | ✓ Yes"
- URL: https://docs.aws.amazon.com/ec2/latest/instancetypes/gp.html
- i4i: "i4i.large | 1 x 468 GB | NVMe SSD | 50,000 / 27,500 | | ✓ Yes" / "i4i.xlarge | 1 x 937 GB | NVMe SSD | 100,000 / 55,000" / "i4i.2xlarge | 1 x 1875 GB | 200,000 / 110,000" / "i4i.4xlarge | 1 x 3750 GB | 400,000 / 220,000" / "i4i.8xlarge | 2 x 3750 GB | 800,000 / 440,000" / "i4i.12xlarge | 3 x 3750 GB | 1,200,000 / 660,000" / "i4i.16xlarge | 4 x 3750 GB | 1,600,000 / 880,000" / "i4i.24xlarge | 6 x 3750 GB | 2,400,000 / 1,320,000" / "i4i.32xlarge | 8 x 3750 GB | 3,200,000 / 1,760,000" / "i4i.metal | 8 x 3750 GB | NVMe SSD | 3,200,000 / 1,760,000 | | ✓ Yes"
- URL: https://docs.aws.amazon.com/ec2/latest/instancetypes/so.html
- Gloss: the "Needs initialization" column is blank for every row above, and TRIM is "Yes" for all of them. The old single "Instance store volume limits" page now only links to these per-family tables and gives one example: "r8id.large supports 1 x 118 GB instance store volume, while r8id.32xlarge supports 2 x 3800 GB instance store volumes." (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-store-volumes.html)

---

## 9. Amazon Linux 2023 kernel configuration and Graviton cpufreq

Source: kernel configs extracted from the AL2023 kernel RPMs served by the AL2023 package CDN (current `latest` mirror GUID `5775d799f6e8c33e94d68682d3490cae250052e8798e544edd2d76501d867228`; the config file inside each RPM is `/lib/modules/<ver>/config`). Neither docs.aws.amazon.com nor GitHub publishes these configs; the AL2023 "Kernel Hardening" and "Kernel changes from AL2" pages do not mention any of the four options asked about (grep of https://docs.aws.amazon.com/linux/al2023/ug/kernel-hardening.html and https://docs.aws.amazon.com/linux/al2023/ug/compare-with-al2-kernel.html returned nothing for `HOTPLUG_SMT`, `CPU_FREQ_DEFAULT_GOV`, `TRANSPARENT_HUGEPAGE`, `NUMA_BALANCING`). A GitHub code search for these symbols in the `amazonlinux` org returned 0 results.

RPMs read:
- kernel-6.1.188-233.386.amzn2023.x86_64.rpm — https://cdn.amazonlinux.com/al2023/core/guids/5775d799f6e8c33e94d68682d3490cae250052e8798e544edd2d76501d867228/x86_64/../../../../blobstore/f568dbda5f276a218416185e63ec74070aaa16e637984cc88dda25ff82eef9e0/kernel-6.1.188-233.386.amzn2023.x86_64.rpm
- kernel-6.1.188-233.386.amzn2023.aarch64.rpm — https://cdn.amazonlinux.com/al2023/core/guids/5775d799f6e8c33e94d68682d3490cae250052e8798e544edd2d76501d867228/aarch64/../../../../blobstore/802e35b496d954b9ee22acf60f93b28ebe37021050417e90b90b7470e146e035/kernel-6.1.188-233.386.amzn2023.aarch64.rpm
- kernel6.12-6.12.110-135.202.amzn2023.x86_64.rpm — https://cdn.amazonlinux.com/al2023/core/guids/5775d799f6e8c33e94d68682d3490cae250052e8798e544edd2d76501d867228/x86_64/../../../../blobstore/2f13b26763e581d4f018cd31cd09ba88c20b42a0ddf2ed7954167b0132acb340/kernel6.12-6.12.110-135.202.amzn2023.x86_64.rpm
- kernel6.12-6.12.110-135.202.amzn2023.aarch64.rpm — https://cdn.amazonlinux.com/al2023/core/guids/5775d799f6e8c33e94d68682d3490cae250052e8798e544edd2d76501d867228/aarch64/../../../../blobstore/4c17077245d9f594f03c20dd6864334ffbac0cafb85858300131bbbebb8b2ec9/kernel6.12-6.12.110-135.202.amzn2023.aarch64.rpm
(Mirror list that resolves the GUID: https://cdn.amazonlinux.com/al2023/core/mirrors/latest/x86_64/mirror.list and .../aarch64/mirror.list)

Verbatim config lines:

| Option | 6.1.188 x86_64 | 6.1.188 aarch64 | 6.12.110 x86_64 | 6.12.110 aarch64 |
|---|---|---|---|---|
| `CONFIG_HOTPLUG_SMT` | `CONFIG_HOTPLUG_SMT=y` | (no line; symbol not selectable on arm64 before v6.15) | `CONFIG_HOTPLUG_SMT=y` | (no line) |
| `CONFIG_SCHED_SMT` | `CONFIG_SCHED_SMT=y` | `# CONFIG_SCHED_SMT is not set` | `CONFIG_SCHED_SMT=y` | `# CONFIG_SCHED_SMT is not set` |
| `CONFIG_CPU_FREQ_DEFAULT_GOV_PERFORMANCE` | `=y` | `=y` | `=y` | `=y` |
| other default governors | all `is not set` (POWERSAVE, USERSPACE, SCHEDUTIL) | all `is not set` (POWERSAVE, USERSPACE, ONDEMAND, CONSERVATIVE, SCHEDUTIL) | same as 6.1 x86_64 | same as 6.1 aarch64 |
| `CONFIG_TRANSPARENT_HUGEPAGE_MADVISE` | `=y` (`# CONFIG_TRANSPARENT_HUGEPAGE_ALWAYS is not set`) | `=y` (ALWAYS not set) | `=y` (ALWAYS not set, `# CONFIG_TRANSPARENT_HUGEPAGE_NEVER is not set`) | `=y` (ALWAYS not set, NEVER not set) |
| `CONFIG_NUMA_BALANCING_DEFAULT_ENABLED` | `=y` (`CONFIG_NUMA_BALANCING=y`) | `=y` | `=y` | `=y` |
| `CONFIG_CPU_FREQ` | `=y` | `=y` | `=y` | `=y` |
| cpufreq drivers | `CONFIG_X86_INTEL_PSTATE=y`, `CONFIG_X86_ACPI_CPUFREQ=m` | `# CONFIG_ACPI_CPPC_CPUFREQ is not set` | `CONFIG_X86_INTEL_PSTATE=y`, `CONFIG_X86_ACPI_CPUFREQ=m` | `# CONFIG_ACPI_CPPC_CPUFREQ is not set` |
| governors built | `CONFIG_CPU_FREQ_GOV_PERFORMANCE=y`, `CONFIG_CPU_FREQ_GOV_SCHEDUTIL=y`, POWERSAVE/USERSPACE/ONDEMAND/CONSERVATIVE `=m` | same | same | same |
| `CONFIG_HOTPLUG_CPU` | `=y` | `=y` | `=y` | `=y` |

Gloss: on x86_64 the SMT control knob exists; on aarch64 it does not (and the scheduler is not even SMT-aware). Default governor is `performance` everywhere. THP defaults to `madvise`. NUMA balancing is on by default. On aarch64 the only ACPI cpufreq driver (`cppc_cpufreq`) is not built, so no cpufreq policy directories are expected on Graviton (derived from config; not observed).

Graviton fixed frequency (AWS docs):
- Quote: "AWS Graviton processors have built-in power saving modes and operate at a fixed frequency. Therefore, they do not provide the ability for the operating system to control C-states and P-states."
- Quote (same page): "The following instance types provide the ability for an operating system to control C-states and P-states: ... Bare metal: All bare metal instances with Intel and AMD processors" and under "C-states only": "... m7i.large | m7i.xlarge | ..." and "c6i.16xlarge | c6i.32xlarge | ...".
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/processor_state_control.html
- Gloss: Intel/AMD bare metal exposes both C- and P-state control; m7i.large exposes C-state control only; Graviton exposes neither.
- Whether `/sys/devices/system/cpu/cpufreq` exists on Graviton under AL2023: NOT FOUND in AWS documentation. The Graviton getting-started README states "Turbo supported | No" and lists fixed frequencies per generation (https://github.com/aws/aws-graviton-getting-started/blob/main/README.md).

AL2023 kernel lifecycle (for context on which kernels exist):
- Quote: "Amazon Linux 2023 (AL2023) releases a new Long-Term Support (LTS) kernel in Q1 of every year, based on the upstream Linux community's annual LTS kernel." / "Starting in June 2026, AL2023 will update the default kernel annually. The al2023-ami-kernel-default set of AMIs will be updated to the latest LTS kernel, so that newly launched instances will come up with the new kernel version." / "Running instances are not automatically updated to a new kernel."
- URL: https://docs.aws.amazon.com/linux/al2023/ug/kernel-lifecycle.html
- Gloss: the hardening page's table header already lists "AL2023/6.18/aarch64 | AL2023/6.18/x86_64" columns, so a 6.18 kernel (which would include arm64 `HOTPLUG_SMT`) is in the AL2023 lineup; its RPM was not in the `latest` core repo as `kernel`/`kernel6.12` names and was not inspected.

---

## 10. `RunInstances MetadataOptions`, `HttpTokens: required`, and `DescribeInstances` fields

### MetadataOptions
- Quote (`RunInstances.MetadataOptions`): "The metadata options for the instance. For more information, see Configure the Instance Metadata Service options." Type: InstanceMetadataOptionsRequest object. Required: No.
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_RunInstances.html
- Quote (`InstanceMetadataOptionsRequest.HttpTokens`): "Indicates whether IMDSv2 is required. optional - IMDSv2 is optional, which means that you can use either IMDSv2 or IMDSv1. required - IMDSv2 is required, which means that IMDSv1 is disabled, and you must use IMDSv2. Default: If the value of ImdsSupport for the Amazon Machine Image (AMI) for your instance is v2.0 and the account level default is set to no-preference, the default is required. If the value of ImdsSupport for the Amazon Machine Image (AMI) for your instance is v2.0, but the account level default is set to V1 or V2, the default is optional. The default value can also be affected by other combinations of parameters." Valid Values: `optional | required`.
- Quote (other fields): `HttpEndpoint`: "Enables or disables the HTTP metadata endpoint on your instances. If you specify a value of disabled, you cannot access your instance metadata. Default: enabled" / `HttpPutResponseHopLimit`: "The maximum number of hops that the metadata token can travel. Possible values: Integers from 1 to 64" / `HttpProtocolIpv6`: "Enables or disables the IPv6 endpoint for the instance metadata service. Default: disabled" / `InstanceMetadataTags`: "Set to enabled to allow access to instance tags from the instance metadata. Set to disabled to turn off access to instance tags from the instance metadata. ... Default: disabled"
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceMetadataOptionsRequest.html
- Quote (user guide): "When requesting instance metadata, IMDSv2 calls require a token. IMDSv1 calls do not require a token. You can configure an instance to allow either IMDSv1 or IMDSv2 calls (where a token is optional), or to only allow IMDSv2 calls (where a token is required)." / "If IMDSv2 enforcement is enabled and httpTokens has not been set to required in either the instance configuration at launch, the account settings, or the AMI configuration, your launch will fail."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-options.html
- Quote (`DescribeInstances` -> `Instance.metadataOptions` -> `InstanceMetadataOptionsResponse`): `httpTokens`: same optional/required text as the request; `state`: "The state of the metadata option changes. pending - The metadata options are being updated and the instance is not ready to process metadata traffic with the new selection. applied - The metadata options have been successfully applied on the instance."
- URL: https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_InstanceMetadataOptionsResponse.html
- Gloss: `HttpTokens=required` is the IMDSv2-only switch; the default depends on AMI `ImdsSupport` and the account-level setting.

### `DescribeInstances` / `Instance` fields (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Instance.html)
- `placement`: "The location where the instance launched, if applicable." Type: Placement object.
  - `Placement` (https://docs.aws.amazon.com/AWSEC2/latest/APIReference/API_Placement.html): `availabilityZoneId`: "The ID of the Availability Zone of the instance. On input, you can specify AvailabilityZone or AvailabilityZoneId, but not both. If you specify neither one, Amazon EC2 automatically selects an Availability Zone for you." / `availabilityZone`: "The Availability Zone of the instance." / `hostId`: "The ID of the Dedicated Host on which the instance resides. This parameter is not supported for CreateFleet or ImportInstance." / `tenancy`: "The tenancy of the instance. An instance with a tenancy of dedicated runs on single-tenant hardware. ... The host tenancy is not supported for ImportInstance or for T3 instances that are configured for the unlimited CPU credit option." Valid Values: `default | dedicated | host` / `groupName`: "The name of the placement group that the instance is in." / `partitionNumber`: "The number of the partition that the instance is in. Valid only if the placement group strategy is set to partition."
- `instanceLifecycle`: "Indicates whether this is a Spot Instance or a Scheduled Instance." Valid Values: `spot | scheduled | capacity-block | interruptible-capacity-reservation`
- `bootMode`: "The boot mode that was specified by the AMI. If the value is uefi-preferred, the AMI supports both UEFI and Legacy BIOS. The currentInstanceBootMode parameter is the boot mode that is used to boot the instance at launch or start. Note: The operating system contained in the AMI must be configured to support the specified boot mode." Valid Values: `legacy-bios | uefi | uefi-preferred`
- `currentInstanceBootMode`: "The boot mode that is used to boot the instance at launch or start." Valid Values: `legacy-bios | uefi`
- `hypervisor`: "The hypervisor type of the instance. The value xen is used for both Xen and Nitro hypervisors." Valid Values: `ovm | xen`
- `architecture`: "The architecture of the image." Valid Values: `i386 | x86_64 | arm64 | x86_64_mac | arm64_mac`
- `virtualizationType`: "The virtualization type of the instance." Valid Values: `hvm | paravirtual`
- `enaSupport`: "Specifies whether enhanced networking with ENA is enabled." (Boolean)
- `ebsOptimized`: "Indicates whether the instance is optimized for Amazon EBS I/O. This optimization provides dedicated throughput to Amazon EBS and an optimized configuration stack to provide optimal I/O performance. This optimization isn't available with all instance types. Additional usage charges apply when using an EBS Optimized instance." (Boolean)
- `cpuOptions`: "The CPU options for the instance." Type: CpuOptions object (fields in section 5).
- `launchTime`: "The time that the instance was last launched. To determine the time that instance was first launched, see the attachment time for the primary network interface."
- `maintenanceOptions`: "Provides information on the recovery and maintenance options of your instance." Type: InstanceMaintenanceOptions (contains `rebootMigration`, section 1).
- Gloss: `Instance.hypervisor` cannot distinguish Nitro from Xen (always `xen`); use `InstanceTypeInfo.hypervisor` (`nitro | xen`) from `DescribeInstanceTypes` for that. `Placement.hostId` is only populated for Dedicated Host tenancy; there is no field exposing the physical host of a shared-tenancy instance.

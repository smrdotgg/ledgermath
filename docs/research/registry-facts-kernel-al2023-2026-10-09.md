# Kernel/sysfs interfaces and EC2 processor-state behaviour — verified facts

Date: 2026-10-09. Method: AWS pages fetched via docs.aws.amazon.com / aws.amazon.com / repost.aws; kernel documentation pulled verbatim from the kernel.org git tree (`git.kernel.org/.../plain/Documentation/...`, which is the source of docs.kernel.org); man pages from man7.org; util-linux source from git.kernel.org; Amazon Linux 2023 package metadata and kernel RPM configs from `cdn.amazonlinux.com` (the AL2023 package CDN). Where a fact is not in any of those sources it is marked **NOT FOUND IN DOCS**. Where a fact comes from kernel *source* rather than kernel *documentation* it is marked **(source, not doc)**.

Working copies of every file quoted below are in `/tmp/lm-kdocs/` (kernel) and `/tmp/lm-al2023/` (AL2023).

---

## 1. AWS: processor state control, Graviton, clocksource

### 1.1 Which instance types support C-state / P-state control

Source: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/processor_state_control.html

Definitions (verbatim):

> **C-states** control the sleep levels that a core can enter when it is idle. C-states are numbered starting with C0 (the shallowest state where the core is totally awake and executing instructions) and go to C6 (the deepest idle state where a core is powered off).
>
> **P-states** control the desired performance (in CPU frequency) from a core. P-states are numbered starting from P0 (the highest performance setting where the core is allowed to use Intel Turbo Boost Technology to increase frequency if possible), and they go from P1 (the P-state that requests the maximum baseline frequency) to P15 (the lowest possible frequency).

Graviton (verbatim, boxed "Note" on the page):

> AWS Graviton processors have built-in power saving modes and operate at a fixed frequency. Therefore, they do not provide the ability for the operating system to control C-states and P-states.

**C-states and P-states** (verbatim list):

> The following instance types provide the ability for an operating system to control C-states and P-states:
> + **General purpose**: `m4.10xlarge` | `m4.16xlarge`
> + **Compute optimized**: `c4.8xlarge`
> + **Memory optimized**: `r4.8xlarge` | `r4.16xlarge` | `x1.16xlarge` | `x1.32xlarge` | `x1e.8xlarge` | `x1e.16xlarge` | `x1e.32xlarge`
> + **Storage optimized**: `d2.8xlarge` | `i3.8xlarge` | `i3.16xlarge` | `h1.8xlarge` | `h1.16xlarge`
> + **Accelerated computing**: `g3.16xlarge` | `p3.16xlarge`
> + **Bare metal**: All bare metal instances with Intel and AMD processors

So: among *virtualized* instances, P-state control is only listed for the pre-Nitro (Xen-era) families above. Every Nitro-era virtualized type appears only in the "C-states only" list. The wording for bare metal is "All bare metal instances with Intel and AMD processors" (no `.metal` sizes are enumerated individually).

**C-states only** (verbatim list; note that for 7th/8th-generation Intel/AMD families *every* size is listed, while for 5th/6th-generation families only the largest sizes are listed):

> + **General purpose**: `m5.12xlarge` | `m5.24xlarge` | `m5d.12xlarge` | `m5d.24xlarge` | `m5n.12xlarge` | `m5n.24xlarge` | `m5dn.12xlarge` | `m5dn.24xlarge` | `m5zn.6xlarge` | `m5zn.12xlarge` | `m6a.24xlarge` | `m6a.48xlarge` | `m6i.16xlarge` | `m6i.32xlarge` | `m6id.16xlarge` | `m6id.32xlarge` | `m6idn.16xlarge` | `m6in.16xlarge` | `m6in.32xlarge` | `m7a.medium` | `m7a.large` | `m7a.xlarge` | `m7a.2xlarge` | `m7a.4xlarge` | `m7a.8xlarge` | `m7a.12xlarge` | `m7a.16xlarge` | `m7a.24xlarge` | `m7a.32xlarge` | `m7a.48xlarge` | `m7i.large` | `m7i.xlarge` | `m7i.2xlarge` | ` m7i.4xlarge` | `m7i.8xlarge` | `m7i.12xlarge` | `m7i.16xlarge` | `m7i.24xlarge` | `m7i.48xlarge` | `m8a.medium` … `m8a.48xlarge` | `m8azn.medium` … `m8azn.24xlarge` | `m8i.large` … `m8i.96xlarge` | `m8id.large` … `m8id.96xlarge` | `m8in.large` … `m8in.96xlarge` | `m8idn.large` … `m8idn.96xlarge` | `m8ib.large` … `m8ib.96xlarge` | `m8idb.large` … `m8idb.96xlarge` | `m8ine.large` … `m8ine.12xlarge`
> + **Compute optimized**: `c5.9xlarge` | `c5.12xlarge` | `c5.18xlarge` | `c5.24xlarge` | `c5a.24xlarge` | `c5ad.24xlarge` | `c5d.9xlarge` | `c5d.12xlarge` | `c5d.18xlarge` | `c5d.24xlarge` | `c5n.9xlarge` | `c5n.18xlarge` | `c6a.24xlarge` | `c6a.32xlarge` | `c6a.48xlarge` | `c6i.16xlarge` | `c6i.32xlarge` | `c6id.24xlarge` | `c6id.32xlarge` | `c6in.32xlarge` | `c7a.medium` … `c7a.48xlarge` | `c7i.large` … `c7i.48xlarge` | `c8a.medium` … `c8a.48xlarge` | `c8i.large` … `c8i.96xlarge` | `c8id.large` … `c8id.96xlarge` | `c8in.large` … `c8in.96xlarge` | `c8ib.large` … `c8ib.96xlarge` | `x8i.large` … `x8i.96xlarge`
> + **Memory optimized**: `r5.12xlarge` | `r5.24xlarge` | `r5b.12xlarge` | `r5d.12xlarge` | `r5d.24xlarge` | `r5n.12xlarge` | `r5n.24xlarge` | `r5dn.12xlarge` | `r5dn.24xlarge` | `r6a.24xlarge` | `r6a.48xlarge` | `r6i.16xlarge` | `r6i.32xlarge` | `r6id.16xlarge` | `r6id.32xlarge` | `r6in.16xlarge` | `r6in.32xlarge` | `r7a.medium` … `r7a.48xlarge` | `r7i.large` … `r7i.48xlarge` | `r7iz.large` … `r7iz.32xlarge` | `r8a.medium` … `r8a.48xlarge` | `r8i.large` … `r8i.96xlarge` | `r8id.large` … `r8id.96xlarge` | `r8in.large` … `r8in.96xlarge` | `r8idn.large` … `r8idn.96xlarge` | `r8ib.large` … `r8ib.96xlarge` | `r8idb.large` … `r8idb.96xlarge` | `u-3tb1.56xlarge` | `u-6tb1.56xlarge` | `u-6tb1.112xlarge` | `u-9tb1.112xlarge` | `u-12tb1.112xlarge` | `u-18tb1.112xlarge` | `u-24tb1.112xlarge` | `u7i-6tb.112xlarge` | `u7i-8tb.112xlarge` | `u7i-12tb.224xlarge` | `u7in-16tb.224xlarge` | `u7in-24tb.224xlarge` | ` u7in-32tb.224xlarge` | `u7inh-32tb.480xlarge` | `x2idn.32xlarge` | `x2iedn.16xlarge` | `x2iedn.32xlarge` | `x2iezn.12xlarge` | `x8aedz.large` … `x8aedz.24xlarge` | `z1d.6xlarge` | `z1d.12xlarge`
> + **Storage optimized**: `d3en.12xlarge` | `dl1.24xlarge` | `i3en.12xlarge` | `i3en.24xlarge` | `i4i.16xlarge` | `i7i.large` … `i7i.48xlarge` | `i7ie.large` … `i7ie.48xlarge` | `r5b.12xlarge` | `r5b.24xlarge`
> + **Accelerated computing**: `dl1.24xlarge` | `f2.6xlarge` | `f2.12xlarge` | `f2.48xlarge` | `g5.24xlarge` | `g5.48xlarge` | `g6.24xlarge` | `g6.48xlarge` | `g6e.12xlarge` | `g6e.24xlarge` | `g6e.48xlarge` | `g7e.2xlarge` … `g7e.48xlarge` | `g7.2xlarge` … `g7.48xlarge` | `inf1.24xlarge` | `p3dn.24xlarge` | `p4d.24xlarge` | `p4de.24xlarge` | `p5.48xlarge` | `p5e.48xlarge` | `p5en.48xlarge` | `p6-b200.48xlarge` | `p6-b300.48xlarge` | `trn1.32xlarge` | `trn2.3xlarge` | `trn2.48xlarge` | `trn2a.3xlarge` | `trn2a.48xlarge` | `trn2n.3xlarge` | `trn2n.48xlarge` | `trn2p.48xlarge` | `trn2u.48xlarge` | `vt1.24xlarge`
> + **High-performance computing**: `hpc7a.12xlarge` | `hpc7a.24xlarge` | `hpc7a.48xlarge` | `hpc7a.96xlarge` | `hpc8a.96xlarge`

(The "…" ranges above abbreviate contiguous size runs that the page spells out one by one: e.g. `m7a.medium | m7a.large | m7a.xlarge | m7a.2xlarge | m7a.4xlarge | m7a.8xlarge | m7a.12xlarge | m7a.16xlarge | m7a.24xlarge | m7a.32xlarge | m7a.48xlarge`. The page itself contains typos such as a leading space in `` ` m7i.4xlarge` `` and a duplicated `x8i.48xlarge`.) No Graviton (`*g`) type appears anywhere in either list.

Rationale paragraph (verbatim):

> You might want to change the C-state or P-state settings to increase processor performance consistency, reduce latency, or tune your instance for a specific workload. The default C-state and P-state settings provide maximum performance, which is optimal for most workloads. However, if your application would benefit from reduced latency at the cost of higher single- or dual-core frequencies, or from consistent performance at lower frequencies as opposed to bursty Turbo Boost frequencies, consider experimenting with the C-state or P-state settings that are available to these instances.

**What AWS says about virtualized Nitro guests controlling C/P-states:** **NOT FOUND IN DOCS** as an explicit statement. The page expresses it only by enumeration (above): virtualized Nitro sizes appear exclusively under "C-states only"; P-state control for Nitro hardware is listed only for "All bare metal instances with Intel and AMD processors". The Nitro overview page (https://docs.aws.amazon.com/ec2/latest/instancetypes/ec2-nitro-instances.html) says only: "The Nitro System provides bare metal capabilities that eliminate virtualization overhead and support workloads that require full access to host hardware. Bare metal instances are well suited for the following: + Workloads that require access to low-level hardware features (for example, Intel VT) that are not available or fully supported in virtualized environments". It does not mention C-states, P-states, SMT, or clock sources.

### 1.2 Kernel parameters and commands AWS shows

Source: https://docs.aws.amazon.com/linux/al2/ug/processor_state_control.html (the EC2 page links here: "These procedures were written for, and apply to Amazon Linux; however, they might also work for other Linux distributions with a Linux kernel of 3.9 or newer.")

Kernel parameters (verbatim):

> Edit the `GRUB_CMDLINE_LINUX_DEFAULT` line and add the `intel_idle.max_cstate=1` and `processor.max_cstate=1` options to set `C1` as the deepest C-state for idle cores.
>
> ```
> GRUB_CMDLINE_LINUX_DEFAULT="console=tty0 console=ttyS0,115200n8 net.ifnames=0 biosdevname=0 nvme_core.io_timeout=4294967295 intel_idle.max_cstate=1 processor.max_cstate=1"
> GRUB_TIMEOUT=0
> ```
>
> The `intel_idle.max_cstate=1` option configures the C-state limit for Intel-based instances, and the `processor.max_cstate=1` option configures the C-state limit for AMD-based instances. It is safe to add both options to your configuration. This allows a single configuration to set the desired behavior on both Intel and AMD.

followed by `sudo grub2-mkconfig -o /boot/grub2/grub.cfg` and `sudo reboot`.

Turbo (verbatim):

> When you need the low processor speed variability that the `P1` P-state provides, run the following command to disable Turbo Boost.
> ```
> [ec2-user ~]$ sudo sh -c "echo 1 > /sys/devices/system/cpu/intel_pstate/no_turbo"
> ```
> When your workload is finished, you can re-enable Turbo Boost with the following command.
> ```
> [ec2-user ~]$ sudo sh -c "echo 0 > /sys/devices/system/cpu/intel_pstate/no_turbo"
> ```

**`cpupower` commands: NOT FOUND IN DOCS.** Neither the EC2 page nor the AL2 page uses `cpupower` for the governor or turbo; two site-restricted searches for `cpupower` / `cpupower frequency-set` on docs.aws.amazon.com and aws.amazon.com returned no AWS page. The AL2 page uses `turbostat` for observation ("The **turbostat** utility is available on Amazon Linux by default.") and the direct sysfs write above for turbo. No governor-setting command appears on either page.

Turbo-boost statements (verbatim):

> ## Highest performance with maximum Turbo Boost frequency
> This is the default processor state control configuration for the Amazon Linux AMI, and it is recommended for most workloads. This configuration provides the highest performance with lower variability. Allowing inactive cores to enter deeper sleep states provides the thermal headroom required for single or dual core processes to reach their maximum Turbo Boost potential.

> In the following example, all 18 cores are actively performing work, so there is no headroom for maximum Turbo Boost, but they are all running at the "all core Turbo Boost" speed of 3.2 GHz.

> You can configure the system to not use deeper C-states, which reduces the processor reaction latency, but that in turn also reduces the headroom available to other cores for Turbo Boost.

> Most workloads perform better in P0, which requests Turbo Boost. But you may want to tune your system for consistent performance rather than bursty performance that can happen when Turbo Boost frequencies are enabled.

> Intel Advanced Vector Extensions (AVX or AVX2) workloads can perform well at lower frequencies, and AVX instructions can use more power. Running the processor at a lower frequency, by disabling Turbo Boost, can reduce the amount of power used and keep the speed more consistent.

Kernel-version requirement and the detection one-liner (verbatim):

> CPU idle drivers control P-state. Newer CPU generations require updated CPU idle drivers that correspond to the kernel level as follows:
> + Linux kernel versions 6.1 and higher – Supports Intel Granite Rapids (for example, R8i)
> + Linux kernel versions 5.10 and higher – Supports AMD Milan (for example, M6a)
> + Linux kernel versions 5.6 and higher – Supports Intel Icelake (for example, M6i)
>
> To detect if a running system's kernel recognizes the CPU, run the following command.
> ```
> if [ -d /sys/devices/system/cpu/cpu0/cpuidle ]; then echo "C-state control enabled"; else echo "Kernel cpuidle driver does not recognize this CPU generation"; fi
> ```

(All examples on the page are from a `c4.8xlarge`; the turbostat output shows 2.90 GHz TSC/baseline, 3.20 GHz all-core turbo, ~3.44–3.45 GHz two-core turbo.)

### 1.3 Graviton: fixed frequency, no SMT, no C-state control

- Fixed frequency / no C/P-state control: the EC2 note quoted in 1.1 ("operate at a fixed frequency … do not provide the ability for the operating system to control C-states and P-states").
- No SMT / threads per core, AWS docs: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/instance-optimize-cpu.html — "Many Amazon EC2 instances support simultaneous multithreading (SMT), which enables multiple threads to run concurrently on a single CPU core. Each thread is represented as a virtual CPU (vCPU) on the instance." and, under Considerations: "You can't modify the number of threads per core for T2, C7a, M7a, R7a, and Apple silicon Mac instances, and instances based on the AWS Graviton processor." (The page does not itself say Graviton is one thread per core.)
- One vCPU per physical core, AWS Graviton Technical Guide (github.com/aws/aws-graviton-getting-started):
  - `perfrunbook/configuring_your_sut.md`: "Graviton processors do not implement SMT (Hyper-Threading), so vCPUs map 1:1 to physical cores and assumptions about two hardware threads per core are incorrect."
  - `perfrunbook/system-load-and-compute-headroom.md` (https://aws.github.io/graviton/perfrunbook/system-load-and-compute-headroom.html): "Graviton processors can execute only one hardware thread, or vCPU, per physical core." and "Our x86 based EC instances in AWS EC2 execute two hardware threads per core, each thread representing a vCPU."
  - `README.md` "Building for Graviton" table: Frequency — Graviton2 2500MHz; Graviton3(E) 2600MHz; Graviton4 "2800MHz (2700MHz for 48xlarge)"; Graviton5 3300MHz; "Turbo supported: No" for every generation.
  - `Monitoring_Tools_on_Graviton.md`: "On AWS Graviton processors, Turbo isn't supported. So, utilities such as 'turbostat' aren't supported/ relevant." and the summary table row "CPU frequency listing | *lscpu, /proc/cpuinfo, dmidecode* (x86) | *dmidecode* (Graviton2,3, and 4)"; note 1: "The ARM Linux kernel community has decided not to put CPU frequency in _/proc/cpuinfo_ which can be read by tools such as _lscpu_ or directly."
- The former whitepaper URL https://docs.aws.amazon.com/whitepapers/latest/aws-graviton-performance-testing/what-is-aws-graviton.html now 301-redirects to https://aws.amazon.com/ec2/graviton/, which contains no SMT/frequency/C-state statements.

### 1.4 Linux clocksource on EC2

- docs.aws.amazon.com: **NOT FOUND IN DOCS.** https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/set-time.html and its sub-pages cover Amazon Time Sync, PTP hardware clock and leap smearing only; no mention of `clocksource`, `tsc`, or `kvm-clock`. The AL2023 user guide has no clocksource page either. The AWS blog "It's About Time: Microsecond-Accurate Clocks on Amazon EC2 Instances" does not mention clocksource.
- AWS re:Post Knowledge Center (labelled "AWS OFFICIAL"; JSON-LD `dateModified` 2024-09-16; https://repost.aws/knowledge-center/manage-ec2-linux-clock-source — fetched via curl; WebFetch gets 403), verbatim:

  > For all Amazon EC2 Intel and AMD instances, it's best practice to use tsc as the clock source. If your instance uses the AWS Xen Hypervisor or the AWS Nitro Hypervisor, then use tsc as the clock source.
  > Note: All AWS Graviton processors use arch_sys_counter as the clock source.

  > To find the current clock source, list the contents of the current_clocksource file:
  > cat /sys/devices/system/clocksource/clocksource0/current_clocksource
  > xen
  > To list the available clock sources, list the contents of the available_clocksource file:
  > cat /sys/devices/system/clocksource/clocksource0/available_clocksource
  > xen tsc hpet acpi_pm

  > sudo bash -c 'echo tsc > /sys/devices/system/clocksource/clocksource0/current_clocksource'
  > … If the override is successful, then the clocksource: Switched to clocksource tsc message appears.
  > Note: If you reboot the system, then the Linux kernel resets the clock source.

  > To permanently set the clock source, set the source in the system boot loader. For example, if you use grub2 and you want to set the clock source to tsc, then open /etc/default/grub in an editor. Then, add clocksource=tsc tsc=reliable for the GRUB_CMDLINE_LINUX option.
  > GRUB_CMDLINE_LINUX="console=tty0 crashkernel=auto console=ttyS0,115200 clocksource=tsc tsc=reliable"
  > grub2-mkconfig -o /boot/grub2/grub.cfg

  The article states a best practice, not what the default is on Nitro. **The documented default on Nitro: NOT FOUND IN DOCS.** (Search-engine summaries of the Spanish copy `repost.aws/es/...` and of an AWS China blog describe an older wording that recommended `kvm-clock` for Nitro and said Nitro "defaults to the KVM clock source"; I did not fetch those pages and the current English article contradicts them, so treat that as unverified history.)

---

## 2. Linux sysfs / proc interfaces (exact paths and value sets)

Primary files (all fetched from https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git/plain/Documentation/...):
- `ABI/testing/sysfs-devices-system-cpu` (rendered at https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-devices-system-cpu)
- `ABI/stable/sysfs-devices-system-cpu`, `ABI/stable/sysfs-devices-node`, `ABI/stable/sysfs-block`, `ABI/stable/sysfs-nvme`, `ABI/testing/sysfs-kernel-mm-transparent-hugepage`
- `admin-guide/pm/cpufreq.rst` (https://docs.kernel.org/admin-guide/pm/cpufreq.html), `admin-guide/pm/intel_pstate.rst`, `admin-guide/pm/amd-pstate.rst`, `admin-guide/pm/cpuidle.rst`, `admin-guide/mm/transhuge.rst`, `admin-guide/mm/ksm.rst`, `admin-guide/sysctl/vm.rst`, `admin-guide/sysctl/kernel.rst`, `admin-guide/kernel-parameters.txt`, `admin-guide/kernel-parameters.rst`, `admin-guide/hw-vuln/l1tf.rst`, `filesystems/proc.rst`, `scheduler/sched-debug.rst`, `scheduler/sched-design-CFS.rst`, `admin-guide/cputopology.rst`

### 2.1 SMT control

`ABI/testing/sysfs-devices-system-cpu` (verbatim):

```
What:		/sys/devices/system/cpu/smt
		/sys/devices/system/cpu/smt/active
		/sys/devices/system/cpu/smt/control
Date:		June 2018
Description:	Control Symmetric Multi Threading (SMT)

		active:  Tells whether SMT is active (enabled and siblings online)

		control: Read/write interface to control SMT. Possible
			 values:

			 "on"		  SMT is enabled
			 "off"		  SMT is disabled
			 "<N>"		  SMT is enabled with N threads per core.
			 "forceoff"	  SMT is force disabled. Cannot be changed.
			 "notsupported"   SMT is not supported by the CPU
			 "notimplemented" SMT runtime toggling is not
					  implemented for the architecture

			 If control status is "forceoff" or "notsupported" writes
			 are rejected. Note that enabling SMT on PowerPC skips
			 offline cores.
```

Note the extra value **`"<N>"`** (a number, e.g. `2`), which the task's list omits. `active` reads `0`/`1`.

https://docs.kernel.org/admin-guide/hw-vuln/l1tf.html, "SMT control": `on` — "SMT is supported by the CPU and enabled. All logical CPUs can be onlined and offlined without restrictions."; `off` — "SMT is supported by the CPU and disabled." (only primary threads can be onlined; onlining a non-primary sibling is rejected); `forceoff` — "Same as 'off' but the state cannot be controlled. Attempts to write to the control file are rejected."; `notsupported` — "The processor does not support SMT. It's therefore not affected by the SMT implications of L1TF."; `active` — "This file reports whether SMT is enabled and active, i.e. if on any physical core two or more sibling threads are online." Kernel params (kernel-parameters.txt): "nosmt [KNL,LOONGARCH,X86,ARM64,PPC,S390] Disable symmetric multithreading (SMT). nosmt=force: Force disable SMT, cannot be undone via the sysfs control file."

### 2.2 cpufreq

`admin-guide/pm/cpufreq.rst`:

- Layout: "That directory contains a ``policyX`` subdirectory (where ``X`` represents an integer number) for every policy object maintained by the ``CPUFreq`` core. Each ``policyX`` directory is pointed to by ``cpufreq`` symbolic links under :file:`/sys/devices/system/cpu/cpuY/` (where ``Y`` represents an integer that may be different from the one represented by ``X``) for all of the CPUs associated with (or belonging to) the given policy." — i.e. `/sys/devices/system/cpu/cpuN/cpufreq` is a symlink to `/sys/devices/system/cpu/cpufreq/policyX`.
- `scaling_driver`: "The scaling driver currently in use."
- `scaling_governor`: "The scaling governor currently attached to this policy or (if the |intel_pstate| scaling driver is in use) the scaling algorithm provided by the driver that is currently applied to this policy. This attribute is read-write and writing to it will cause a new scaling governor to be attached to this policy or a new scaling algorithm provided by the scaling driver to be applied to it (in the |intel_pstate| case), as indicated by the string written to this attribute (which must be one of the names listed by the ``scaling_available_governors`` attribute described above)."
- `scaling_available_governors`: "List of ``CPUFreq`` scaling governors present in the kernel that can be attached to this policy or (if the |intel_pstate| scaling driver is in use) list of scaling algorithms provided by the driver that can be applied to this policy. [Note that some governors are modular and it may be necessary to load a kernel module for the governor held by it to become available and be listed by this attribute.]"
- `scaling_max_freq`: "Maximum frequency the CPUs belonging to this policy are allowed to be running at (in kHz). This attribute is read-write and writing a string representing an integer to it will cause a new limit to be set (it must not be lower than the value of the ``scaling_min_freq`` attribute)."
- `scaling_min_freq`: "Minimum frequency the CPUs belonging to this policy are allowed to be running at (in kHz). This attribute is read-write and writing a string representing a non-negative integer to it will cause a new limit to be set (it must not be higher than the value of the ``scaling_max_freq`` attribute)."
- Generic governors documented on the page: `performance`, `powersave`, `userspace`, `schedutil`, `ondemand`, `conservative`.
- `/sys/devices/system/cpu/cpufreq/boost`: "This file is located under :file:`/sys/devices/system/cpu/cpufreq/` and controls the "boost" setting for the whole system. It is not present if the underlying scaling driver does not support the frequency boost mechanism (or supports it, but provides a driver-specific interface for controlling it, like |intel_pstate|). If the value in this file is 1, the frequency boost mechanism is enabled. … If the value in this file is 0, the frequency boost mechanism is disabled and cannot be used at all. The only values that can be written to this file are 0 and 1." ABI file: "This switch controls the boost setting for the whole system. Boosting allows the CPU and the firmware to run at a frequency beyond its nominal limit."
- `energy_performance_preference` is **not** documented in cpufreq.rst (grep: no hits); it is documented in intel_pstate.rst and amd-pstate.rst (below). Kernel params: `cpufreq.off=1 [CPU_FREQ] disable the cpufreq sub-system`; `cpufreq.default_governor= [CPU_FREQ] Name of the default cpufreq governor or policy to use.`

**intel_pstate** (`admin-guide/pm/intel_pstate.rst`), global attributes in `/sys/devices/system/cpu/intel_pstate/`:

- `status`: "Operation mode of the driver: "active", "passive" or "off"." — "active": "The driver is functional and in the active mode"; "passive": "The driver is functional and in the passive mode"; "off": "The driver is not functional (it is not registered as a scaling driver with the ``CPUFreq`` core)."
- `no_turbo`: "If set (equal to 1), the driver is not allowed to set any turbo P-states (see :ref:`turbo`). If unset (equal to 0, which is the default), turbo P-states can be set by the driver. [Note that ``intel_pstate`` does not support the general ``boost`` attribute (supported by some other scaling drivers) which is replaced by this one.]"
- `max_perf_pct`: "Maximum P-state the driver is allowed to set in percent of the maximum supported performance level (the highest supported turbo P-state). This attribute will not be exposed if the ``intel_pstate=per_cpu_perf_limits`` argument is present in the kernel command line."
- `min_perf_pct`: "Minimum P-state the driver is allowed to set in percent of the maximum supported performance level (the highest supported turbo P-state)." (same per_cpu_perf_limits caveat)
- Active-mode `scaling_available_governors`: "List of P-state selection algorithms provided by ``intel_pstate``." and "There are two P-state selection algorithms provided by ``intel_pstate`` in the active mode: ``powersave`` and ``performance``." (kernel-parameters.txt, `intel_pstate=active`).
- `energy_performance_preference` / `energy_performance_available_preferences` (per-policy, HWP): "``energy_performance_available_preferences`` List of strings that can be written to the ``energy_performance_preference`` attribute. They represent different energy vs performance hints and should be self-explanatory, except that ``default`` represents whatever hint value was set by the platform firmware." "It is also possible to write a positive integer value between 0 to 255, if the EPP feature is present. If the EPP feature is not present, writing integer value to this attribute is not supported." **The doc does not enumerate the strings.** (source, not doc) `drivers/cpufreq/intel_pstate.c` `energy_perf_strings[]`: `"default"`, `"performance"`, `"balance_performance"`, `"balance_power"`, `"power"`.
- `intel_pstate=` kernel parameter values (kernel-parameters.txt): `disable`, `active`, `passive`, `force`, `no_hwp`, `hwp_only`, `support_acpi_ppc`, `per_cpu_perf_limits`, `no_cas`.

**amd_pstate** (`admin-guide/pm/amd-pstate.rst`):

- `/sys/devices/system/cpu/amd_pstate/status`: "Operation mode of the driver: "active", "passive", "guided" or "disable"." — "disable": "The driver is unregistered and not functional now."; writing one of those strings switches mode or unregisters.
- `/sys/devices/system/cpu/amd_pstate/prefcore`: "Preferred core state of the driver: "enabled" or "disabled"."
- Per-policy (read-only): `amd_pstate_highest_perf`, `amd_pstate_max_freq`, `amd_pstate_lowest_nonlinear_freq`, `amd_pstate_hw_prefcore`, `amd_pstate_prefcore_ranking`.
- `energy_performance_available_preferences`: "``default`` represents the epp value is set by platform firmware. ``custom`` designates that integer values 0-255 may be written as well. ``dynamic`` designates that the EPP is modified dynamically on kernel events." `energy_performance_preference`: "Users can also write individual integer values between 0 to 255. Lower epp values shift the bias towards improved performance while a higher epp value shifts the bias towards power-savings." (source, not doc) `drivers/cpufreq/amd-pstate.c` `energy_perf_strings[]`: `"default"`, `"performance"`, `"balance_performance"`, `"balance_power"`, `"power"`, `"custom"`, `"dynamic"`.
- Boost: per-CPU, not global — "To manipulate the `boost` attribute, users can write a value of `0` to disable the boost or `1` to enable it, for the respective CPU using the sysfs path `/sys/devices/system/cpu/cpuX/cpufreq/boost`, where `X` represents the CPU number." cpufreq.rst also documents the legacy per-policy `cpb` knob for acpi-cpufreq on AMD.
- `amd_pstate=` kernel parameter: `disable`, `passive`, `active`, `guided`; `amd_prefcore=disable`.

### 2.3 cpuidle

`admin-guide/pm/cpuidle.rst`:

- "There are four ``CPUIdle`` governors available, ``menu``, `TEO`, ``ladder`` and ``haltpoll``." "The name of the ``CPUIdle`` governor currently used by the kernel can be read from the :file:`current_governor_ro` or :file:`current_governor` file under :file:`/sys/devices/system/cpu/cpuidle/` in ``sysfs``." "Available governors can be read from the :file:`available_governors`". "The name of the ``CPUIdle`` driver currently used by the kernel can be read from the :file:`current_driver` file under :file:`/sys/devices/system/cpu/cpuidle/` in ``sysfs``." x86 drivers named: ``intel_idle`` and ``acpi_idle``.
- Per-state attributes in `/sys/devices/system/cpu/cpuN/cpuidle/stateM/`: ``desc`` "Description of the idle state."; ``disable`` "Whether or not this idle state is disabled."; ``default_status`` "The default status of this state, "enabled" or "disabled"."; ``latency`` "Exit latency of the idle state in microseconds."; ``name`` "Name of the idle state."; ``residency`` "Target residency of the idle state in microseconds."; plus ``power``, ``time``, ``usage``, ``above``, ``below``. "The ``disable`` attribute is the only writeable one."
- ABI file: `disable` "(RW) Option to disable this idle state (bool). The behavior and the effect of the disable variable depends on the implementation of a particular governor. In the ladder governor, for example, it is not coherent …"; `name` "(RO) Name of the idle state (string)."; `latency` "(RO) The latency to exit out of this idle state (in microseconds)."; `residency` "(RO) Display the target residency i.e. the minimum amount of time (in microseconds) this cpu should spend in this idle state to make the transition worth the effort."
- Kernel params: "the ``intel_idle.max_cstate=<n>`` and ``processor.max_cstate=<n>`` parameters, where ``<n>`` is an idle state index also used in the name of the given state's directory in ``sysfs`` …, causes the ``intel_idle`` and ``acpi_idle`` drivers, respectively, to discard all of the idle states deeper than idle state ``<n>``. … Adding ``intel_idle.max_cstate=0`` to the kernel command line disables the ``intel_idle`` driver and allows ``acpi_idle`` to be used, whereas ``processor.max_cstate=0`` is equivalent to ``processor.max_cstate=1``." kernel-parameters.txt: `intel_idle.max_cstate= [KNL,HW,ACPI,X86] 0 disables intel_idle and fall back on acpi_idle. 1 to 9 specify maximum depth of C-state.`; `processor.max_cstate= [HW,ACPI] Limit processor to maximum C-state max_cstate=9 overrides any DMI blacklist limit.`; `cpuidle.off=1 [CPU_IDLE] disable the cpuidle sub-system`; `cpuidle.governor= [CPU_IDLE] Name of the cpuidle governor to use.`; `idle= [X86,EARLY] Format: idle=poll, idle=halt, idle=nomwait` and `[ARM64,EARLY] Format: idle=wfi, idle=yield, idle=nop`.
- arm64 driver names (source, not doc): `drivers/cpuidle/cpuidle-psci.c` `.name = "psci-cpuidle"` (state 0 name `"WFI"`, desc `"ARM WFI"`); `drivers/cpuidle/cpuidle-arm.c` `.name = "arm_idle"`. **There is no driver named `psci_idle`.**

### 2.4 Transparent hugepages

`admin-guide/mm/transhuge.rst`:

- `enabled`: `echo always|madvise|never >/sys/kernel/mm/transparent_hugepage/enabled`. "By default, PMD-sized hugepages have enabled="inherit" and all other hugepage sizes have enabled="never"." Boot parameter: "You can change the sysfs boot time default for the top-level "enabled" control by passing the parameter ``transparent_hugepage=always`` or ``transparent_hugepage=madvise`` or ``transparent_hugepage=never`` to the kernel command line." The compiled-in default is a Kconfig choice (`mm/Kconfig`: `prompt "Transparent Hugepage Support sysfs defaults"`, `default TRANSPARENT_HUGEPAGE_ALWAYS`, options `TRANSPARENT_HUGEPAGE_ALWAYS` "always", `TRANSPARENT_HUGEPAGE_MADVISE` "madvise", `TRANSPARENT_HUGEPAGE_NEVER` "never").
- `defrag`: `echo always|defer|defer+madvise|madvise|never >/sys/kernel/mm/transparent_hugepage/defrag`. "madvise — will enter direct reclaim like ``always`` but only for regions that are have used madvise(MADV_HUGEPAGE). This is the default behaviour."
- `khugepaged/defrag`: "it's also possible to disable defrag in khugepaged by writing 0 or enable defrag in khugepaged by writing 1: echo 0 >/sys/kernel/mm/transparent_hugepage/khugepaged/defrag / echo 1 >…". Default value: NOT FOUND IN DOCS.
- `shmem_enabled`: "the sysfs knob /sys/kernel/mm/transparent_hugepage/shmem_enabled will affect the allocation policy of tmpfs mounts, when set to the following values: deny — For use in emergencies, to force the huge option off from all mounts; force — Force the huge option on for all - very useful for testing;" plus "The global knob has the same semantics as the ``huge=`` mount options for tmpfs mounts" — i.e. `always`, `within_size`, `advise`, `never`, `deny`, `force` (kernel-parameters.txt `transparent_hugepage_shmem= Format: [always|within_size|advise|never|deny|force]`). "The tmpfs mount default policy is ``never``."
- ABI file lists the directory contents: `defrag`, `enabled`, `hpage_pmd_size`, `khugepaged`, `shmem_enabled`, `use_zero_page`, `hugepages-<size>kB/`.

### 2.5 drop_caches and /proc/meminfo

`admin-guide/sysctl/vm.rst`, verbatim:

> Writing to this will cause the kernel to drop clean caches, as well as reclaimable slab objects like dentries and inodes.  Once dropped, their memory becomes free.
> To free pagecache:: echo 1 > /proc/sys/vm/drop_caches
> To free reclaimable slab objects (includes dentries and inodes):: echo 2 > /proc/sys/vm/drop_caches
> To free slab objects and pagecache:: echo 3 > /proc/sys/vm/drop_caches
> This is a non-destructive operation and will not free any dirty objects. To increase the number of objects freed by this operation, the user may run `sync` prior to writing to /proc/sys/vm/drop_caches.  This will minimize the number of dirty objects on the system and create more candidates to be dropped.
> This file is not a means to control the growth of the various kernel caches (inodes, dentries, pagecache, etc...)  These objects are automatically reclaimed by the kernel when memory is needed elsewhere on the system.
> Use of this file can cause performance problems. … use outside of a testing or debugging environment is not recommended.
> You may see informational messages in your kernel log when this file is used:: cat (1234): drop_caches: 3 — These are informational only. … To disable them, echo 4 (bit 2) into drop_caches.

Persistence: the doc describes it purely as an action triggered by a write ("Writing to this will cause…"); it contains no statement about the value persisting or about what a read returns. An explicit "not a persistent state" sentence is **NOT FOUND IN DOCS**.

`filesystems/proc.rst` meminfo fields, verbatim: `MemTotal` "Total usable RAM (i.e. physical RAM minus a few reserved bits and the kernel binary code)"; `MemFree` "Total free RAM. On highmem systems, the sum of LowFree+HighFree"; `MemAvailable` "An estimate of how much memory is available for starting new applications, without swapping. Calculated from MemFree, SReclaimable, the size of the file LRU lists, and the low watermarks in each zone. The estimate takes into account that the system needs some page cache to function well, and that not all reclaimable slab will be reclaimable, due to items being in use. The impact of those factors will vary from system to system."; `Buffers` "Relatively temporary storage for raw disk blocks shouldn't get tremendously large (20MB or so)"; `Cached` "In-memory cache for files read from the disk (the pagecache) as well as tmpfs & shmem. Doesn't include SwapCached."; `Dirty` "Memory which is waiting to get written back to the disk"; `Writeback` "Memory which is actively being written back to the disk"; `AnonHugePages` "Non-file backed huge pages mapped into userspace page tables"; `Shmem` "Total memory used by shared memory (shmem) and tmpfs". Table 1-5: `cmdline` "Kernel command line, both from bootloader and embedded in the kernel image"; `swaps` "Swap space utilization".

### 2.6 mincore(2), fincore(1), posix_fadvise(2)

- https://man7.org/linux/man-pages/man2/mincore.2.html: `int mincore(void *addr, size_t length, unsigned char *vec);` (as rendered by man7.org) "mincore - determine whether pages are resident in memory". "The _addr_ argument must be a multiple of the system page size." "the least significant bit of each byte will be set if the corresponding page is currently resident in memory" (other bits undefined/reserved). "the information returned in _vec_ is only a snapshot" (pages not locked "can come and go at any moment"). STANDARDS: "None." BUGS: "Before Linux 2.6.21, mincore() did not return correct information for MAP_PRIVATE mappings, or for nonlinear mappings".
- https://man7.org/linux/man-pages/man1/fincore.1.html: "fincore - count pages of file contents in core"; `fincore [options] file...`; uses cachestat(2) and falls back to mincore(2); options `-b/--bytes`, `-n/--noheadings`, `-o/--output list`, `--output-all`, `-r/--raw`, `-J/--json`, `-c/--total`, `-h`, `-V`; "The fincore command is part of the util-linux package." The man page does not list columns (says to use `--help`); (source, not doc) util-linux `misc-utils/fincore.c` columns: `PAGES` "file data resident in memory in pages", `RES` "file data resident in memory in bytes", `SIZE` "size of the file", `FILE` "file name", plus `DIRTY_PAGES`, `DIRTY`, `WRITEBACK_PAGES`, `WRITEBACK`, `EVICTED_PAGES`, `EVICTED`, `RECENTLY_EVICTED_PAGES`, `RECENTLY_EVICTED` (cachestat-only columns; AL2023 ships util-linux 2.37.4, which predates cachestat and these extra columns).
- https://man7.org/linux/man-pages/man2/posix_fadvise.2.html: `int posix_fadvise(int fd, off_t offset, off_t size, int advice);` The advice "is not binding; it merely constitutes an expectation on behalf of the application." `POSIX_FADV_DONTNEED`: attempts to free cached pages for the region; "Requests to discard partial pages are ignored"; offset and size should be page-aligned; the kernel may write back dirty pages but this is not guaranteed and unwritten dirty pages are not freed — call fsync(2)/fdatasync(2) first. `size` = 0 means "until the end of the file" (before Linux 2.6.6 it meant literally 0 bytes). NOTES mention `/proc/sys/vm/drop_caches` and mincore(2) for residency checks.

### 2.7 CPU topology, NUMA nodes, caches

`ABI/stable/sysfs-devices-system-cpu` (verbatim):

- `topology/core_id`: "the CPU core ID of cpuX. Typically it is the hardware platform's identifier (rather than the kernel's). The actual value is architecture and platform dependent. Values: integer"
- `topology/die_id`, `topology/cluster_id`: same wording for die / cluster.
- `topology/core_cpus`: "internal kernel map of CPUs within the same core. (deprecated name: "thread_siblings") Values: hexadecimal bitmask."
- `topology/core_cpus_list`: "human-readable list of CPUs within the same core. The format is like 0-3, 8-11, 14,17. (deprecated name: "thread_siblings_list"). Values: decimal list."
- `topology/package_cpus` / `package_cpus_list`: "internal kernel map of the CPUs sharing the same physical_package_id. (deprecated name: "core_siblings")." / "(deprecated name: "core_siblings_list")"
- `topology/die_cpus_list`, `cluster_cpus_list`: analogous.

`ABI/testing/sysfs-devices-system-cpu`: `physical_package_id` "physical package id of cpuX. Typically corresponds to a physical socket number, but the actual value is architecture and platform dependent."; `thread_siblings_list` "human-readable list of cpuX's hardware threads within the same core as cpuX"; `core_siblings_list` "human-readable list of the logical CPU numbers within the same physical_package_id as cpuX." `admin-guide/cputopology.rst`: "die, cluster, book, and drawer hierarchy related sysfs files will only be created if an architecture provides the related macros."

`ABI/stable/sysfs-devices-node` (verbatim): `nodeX/cpulist` "The CPUs associated to the node."; `nodeX/cpumap` "The node's cpumap."; `nodeX/meminfo` "Provides information about the node's distribution and memory utilization. Similar to /proc/meminfo, see Documentation/filesystems/proc.rst"; `nodeX/distance` "Distance between the node and all the other nodes in the system."; `nodeX/numastat` "The node's hit/miss statistics, in units of pages."

Cache, `ABI/testing/sysfs-devices-system-cpu`, `/sys/devices/system/cpu/cpu*/cache/index*/` (verbatim): `coherency_line_size` "the minimum amount of data in bytes that gets transferred from memory to cache"; `level` "the cache hierarchy in the multi-level cache configuration"; `shared_cpu_list` "the list of logical cpus sharing the cache"; `shared_cpu_map` "logical cpu mask containing the list of cpus sharing the cache"; `size` "the total cache size in kB"; `type` "- Instruction: cache that only holds instructions - Data: cache that only caches data - Unified: cache that holds both data and instructions"; also `allocation_policy` (WriteAllocate/ReadAllocate/ReadWriteAllocate), `number_of_sets`, `physical_line_partition`, `ways_of_associativity`, `write_policy` (WriteThrough/WriteBack), `id`.

### 2.8 Vulnerabilities, mitigations=, /proc/cmdline

`ABI/testing/sysfs-devices-system-cpu` lists `/sys/devices/system/cpu/vulnerabilities/` files: `gather_data_sampling`, `indirect_target_selection`, `itlb_multihit`, `l1tf`, `mds`, `meltdown`, `mmio_stale_data`, `old_microcode`, `reg_file_data_sampling`, `retbleed`, `spec_store_bypass`, `spectre_v1`, `spectre_v2`, `srbds`, `tsa`, `tsx_async_abort`, `vmscape`. "Possible output values: "Not affected" CPU is not affected by the vulnerability; "Vulnerable" CPU is affected and no mitigation in effect; "Mitigation: $M" CPU is affected and mitigation $M is in effect". (Real files append detail after these prefixes, e.g. "Vulnerable: ..." / "Mitigation: PTI".)

`kernel-parameters.txt` `mitigations=` (verbatim, abridged to the option names): "[X86,PPC,S390,ARM64,EARLY] Control optional mitigations for CPU vulnerabilities. … Note, "mitigations" is supported if and only if the kernel was built with CPU_MITIGATIONS=y." `off` — "Disable all optional CPU mitigations. This improves system performance, but it may also expose users to several CPU vulnerabilities. Equivalent to: … gather_data_sampling=off [X86] indirect_target_selection=off [X86] kvm.nx_huge_pages=off [X86] l1tf=off [X86] mds=off [X86] mmio_stale_data=off [X86] … nopti [X86,PPC] nospectre_bhb [ARM64] nospectre_v1 [X86,PPC] nospectre_v2 [X86,PPC,S390,ARM64] reg_file_data_sampling=off [X86] retbleed=off [X86] spec_rstack_overflow=off [X86] spec_store_bypass_disable=off [X86,PPC] spectre_bhi=off [X86] spectre_v2_user=off [X86] srbds=off [X86,INTEL] ssbd=force-off [ARM64] tsa=off [X86,AMD] tsx_async_abort=off [X86] vmscape=off [X86]"; `auto (default)` — "Mitigate all CPU vulnerabilities, but leave SMT enabled, even if it's vulnerable."; `auto,nosmt` — "Mitigate all CPU vulnerabilities, disabling SMT if needed." "[X86] After one of the above options, additionally supports attack-vector based controls as documented in Documentation/admin-guide/hw-vuln/attack_vector_controls.rst". `/proc/cmdline`: see 2.5.

### 2.9 sysctls and misc knobs

- `/proc/sys/kernel/numa_balancing` (`sysctl/kernel.rst`): "Enables/disables and configures automatic page fault based NUMA memory balancing. Memory is moved automatically to nodes that access it often. The value to set can be the result of ORing the following: 0 NUMA_BALANCING_DISABLED 1 NUMA_BALANCING_NORMAL 2 NUMA_BALANCING_MEMORY_TIERING". Boot param: `numa_balancing= [KNL,ARM64,PPC,RISCV,S390,X86] Enable or disable automatic NUMA balancing. Allowed values are enable and disable`.
- `/proc/sys/kernel/randomize_va_space`: "0 Turn the process address space randomization off. This is the default for architectures that do not support this feature anyways, and kernels that are booted with the "norandmaps" parameter. 1 Make the addresses of mmap base, stack and VDSO page randomized. … This is the default if the ``CONFIG_COMPAT_BRK`` option is enabled. 2 Additionally enable heap randomization. This is the default if ``CONFIG_COMPAT_BRK`` is disabled." `norandmaps` = "Don't use address space randomization. Equivalent to echo 0 > /proc/sys/kernel/randomize_va_space".
- `/proc/sys/vm/swappiness` (`sysctl/vm.rst`): "This control is used to define the rough relative IO cost of swapping and filesystem paging, as a value between 0 and 200. At 100, the VM assumes equal IO cost and will thus apply memory pressure to the page cache and swap-backed pages equally; lower values signify more expensive swap IO, higher values indicates cheaper." Default 60 (per the rendered page's "The default value is 60.").
- `/proc/swaps` (https://man7.org/linux/man-pages/man5/proc_swaps.5.html): "Swap areas in use. See also swapon(8)." Column format: NOT FOUND IN DOCS.
- `/sys/kernel/mm/ksm/run` (`admin-guide/mm/ksm.rst`): "set to 0 to stop ksmd from running but keep merged pages, set to 1 to run ksmd e.g. ``echo 1 > /sys/kernel/mm/ksm/run``, set to 2 to stop ksmd and unmerge all pages currently merged, but leave mergeable areas registered for next run. Default: 0 (must be changed to 1 to activate KSM, except if CONFIG_SYSFS is disabled)". (AL2023 kernels are built with `# CONFIG_KSM is not set` — see 3.)
- `/proc/sys/kernel/sched_autogroup_enabled`: not in `sysctl/kernel.rst` (no hit). https://man7.org/linux/man-pages/man7/sched.7.html: "this feature is enabled or disabled via the file /proc/sys/kernel/sched_autogroup_enabled; a value of 0 disables the feature, while a value of 1 enables it. The default value in this file is 1, unless the kernel was booted with the _noautogroup_ parameter." Requires CONFIG_SCHED_AUTOGROUP. kernel-parameters.txt: `noautogroup Disable scheduler automatic task group creation.`
- `/sys/kernel/debug/sched/*` (`scheduler/sched-debug.rst`): "Booting a kernel with debugfs enabled will give access to scheduler specific debug files under /sys/kernel/debug/sched." Documented: `numa_balancing/` directory with `scan_period_min_ms`, `scan_delay_ms`, `scan_period_max_ms`, `scan_size_mb`. `scheduler/sched-design-CFS.rst`: "There is only one central tunable: /sys/kernel/debug/sched/base_slice_ns". Other files under that directory (e.g. `features`, `preempt`, `migration_cost_ns`) are not documented in those two files.

### 2.10 Clocksource sysfs and clock kernel parameters

- `/sys/devices/system/clocksource/clocksource0/{current_clocksource,available_clocksource}`: **no ABI document exists** (no `Documentation/ABI/*/sysfs-*clocksource*` file in the tree). (source, not doc) `kernel/time/clocksource.c`: bus `clocksource_subsys` `.name = "clocksource"`, `.dev_name = "clocksource"`, device `.id = 0` → `/sys/devices/system/clocksource/clocksource0/`; attributes `DEVICE_ATTR_RW(current_clocksource)` ("sysfs interface for current clocksource" / "interface for manually overriding clocksource"), `DEVICE_ATTR_RO(available_clocksource)` ("sysfs interface for listing clocksource" — "listing registered clocksources"), `DEVICE_ATTR_WO(unbind_clocksource)`. The AWS re:Post page (1.4) uses exactly these paths.
- `clocksource=` (kernel-parameters.txt): "Override the default clocksource Format: <string> Override the default clocksource and use the clocksource with the name specified. Some clocksource names to choose from, depending on the platform: [all] jiffies (this is the base, fallback clocksource) [ACPI] acpi_pm … [X86-32] pit,hpet,tsc; …"
- `tsc=`: "Disable clocksource stability checks for TSC. Format: <string> [x86] reliable: mark tsc clocksource as reliable, this disables clocksource verification at runtime, as well as the stability checks done at bootup. Used to enable high-resolution timer mode on older hardware, and in virtualized environment. [x86] noirqtime … [x86] unstable … [x86] nowatchdog: disable clocksource watchdog. Used in situations with strict latency requirements (where interruptions from clocksource watchdog are not acceptable). [x86] recalibrate … [x86] watchdog: Enforce the clocksource watchdog on TSC"

### 2.11 CPU isolation kernel parameters and IRQ affinity

`kernel-parameters.rst`, "cpu lists": "Some kernel parameters take a list of CPUs as a value, e.g. isolcpus, nohz_full, irqaffinity, rcu_nocbs. The format of this list is: <cpu number>,...,<cpu number> or <cpu number>-<cpu number> (must be a positive range in ascending order) or a mixture … The value "N" can be used to represent the numerically last CPU on the system, i.e "foo_cpus=16-N" would be equivalent to "16-31" on a 32 core system."

`kernel-parameters.txt` (verbatim):

- `nohz_full= [KNL,BOOT,SMP,ISOL] The argument is a cpu list, as described above. In kernels built with CONFIG_NO_HZ_FULL=y, set the specified list of CPUs whose tick will be stopped whenever possible. The boot CPU will be forced outside the range to maintain the timekeeping. Any CPUs in this list will have their RCU callbacks offloaded, just as if they had also been called out in the rcu_nocbs= boot parameter. Note that this argument takes precedence over the CONFIG_RCU_NOCB_CPU_DEFAULT_ALL option.`
- `isolcpus= [KNL,SMP,ISOL] Isolate a given set of CPUs from disturbance. Format: [flag-list,]<cpu-list>` — flags `nohz` ("Disable the tick when a single task runs as well as disabling other kernel noises like having RCU callbacks offloaded. This is equivalent to the nohz_full parameter. A residual 1Hz tick is offloaded to workqueues, which you need to affine to housekeeping through the global workqueue's affinity configured via the /sys/devices/virtual/workqueue/cpumask sysfs file, or by using the 'domain' flag described below."), `domain` (default; "Isolate from the general SMP balancing and scheduling algorithms. Note that performing domain isolation this way is irreversible … Use cpusets for a dynamic configuration which can be altered at runtime."), `managed_irq` ("Isolate from being targeted by managed interrupts which have an interrupt mask containing isolated CPUs. The affinity of managed interrupts is handled by the kernel and cannot be changed via the /proc/irq/* interfaces. This isolation is best effort …").
- `rcu_nocbs[=cpu-list] [KNL] The optional argument is a cpu list, as described above. In kernels built with CONFIG_RCU_NOCB_CPU=y, enable the no-callback CPU mode, which prevents such CPUs' callbacks from being invoked in softirq context. Invocation of such CPUs' RCU callbacks will instead be offloaded to "rcuox/N" kthreads created for that purpose … This reduces OS jitter on the offloaded CPUs, which can be useful for HPC and real-time workloads. … If a cpulist is passed as an argument, the specified list of CPUs is set to no-callback mode from boot. Otherwise, if the '=' sign and the cpulist arguments are omitted, no CPU will be set to no-callback mode from boot but the mode may be toggled at runtime via cpusets.`
- `irqaffinity= [SMP] Set the default irq affinity mask The argument is a cpu list, as described above.`
- `/proc/irq/default_smp_affinity` (`filesystems/proc.rst`): "The default_smp_affinity mask applies to all non-active IRQs, which are the IRQs which have not yet been allocated/activated, and hence which lack a /proc/irq/[0-9]* directory." and "smp_affinity is a bitmask, in which you can specify which CPUs can handle the IRQ."

### 2.12 Block / NVMe sysfs

`ABI/stable/sysfs-block` (verbatim):

- `/sys/block/<disk>/queue/scheduler`: "[RW] When read, this file will display the current and available IO schedulers for this block device. The currently active IO scheduler will be enclosed in [] brackets. Writing an IO scheduler name to this file will switch control of this block device to that new IO scheduler. Note that writing an IO scheduler name to this file will attempt to load that IO scheduler module, if it isn't already present in the system."
- `queue/nr_requests`: "[RW] This controls how many requests may be allocated in the block layer. Noted this value only represents the quantity for a single blk_mq_tags instance. The actual number for the entire device depends on the hardware queue count, whether elevator is enabled, and whether tags are shared."
- `queue/read_ahead_kb`: "[RW] Maximum number of kilobytes to read-ahead for filesystems on this block device. For MADV_HUGEPAGE, the readahead size may exceed this setting since its granularity is based on the hugepage size."
- `queue/rotational`: "[RW] This file is used to stat if the device is of rotational type or non-rotational type."
- `queue/logical_block_size`: "[RO] This is the smallest unit the storage device can address. It is typically 512 bytes."
- `queue/physical_block_size`: "[RO] This is the smallest unit a physical storage device can write atomically. It is usually the same as the logical block size but may be bigger. …"
- `queue/discard_granularity`: "[RO] Devices that support discard functionality may internally allocate space using units that are bigger than the logical block size. The discard_granularity parameter indicates the size of the internal allocation unit in bytes if reported by the device. Otherwise the discard_granularity will be set to match the device's physical block size. A discard_granularity of 0 means that the device does not support discard functionality."

NVMe identity: `ABI/stable/sysfs-nvme` (verbatim): "What: /sys/class/nvme/nvmeX/model What: /sys/class/nvme/nvmeX/serial What: /sys/class/nvme/nvmeX/firmware_rev Date: January 2016 KernelVersion: 4.5 Description: Shows the model, serial number, or firmware revision string of the NVMe controller, as reported in the Identify Controller data structure." `/sys/block/nvmeXnY/device/...` is **not documented** in `sysfs-block`. (source, not doc) `drivers/nvme/host/core.c`: the per-controller namespace disk is added with `device_add_disk(ctrl->device, ns->disk, …)` so `/sys/block/nvmeXnY/device` → the controller (`/sys/class/nvme/nvmeX`); with native multipath, `drivers/nvme/host/multipath.c` adds the head disk with `device_add_disk(&head->subsys->dev, head->disk, …)` so `device` → the subsystem (`/sys/class/nvme-subsystem/nvme-subsysN`), and `drivers/nvme/host/sysfs.c` gives the subsystem device the same `model`, `serial`, `firmware_rev` attributes (`nvme_subsys_show_str_function(model/serial/firmware_rev)`). Either way `/sys/block/nvmeXnY/device/{model,serial,firmware_rev}` resolves.

---

## 3. Amazon Linux 2023 specifics

### 3.1 THP default

- AL2023 user guide / release notes: **NOT FOUND IN DOCS** (the kernel-hardening and "kernel changes from AL2" pages list many CONFIG values but not `CONFIG_TRANSPARENT_HUGEPAGE_*`; no page mentions `transparent_hugepage`).
- Kernel build config (extracted from the AL2023 kernel RPMs on `cdn.amazonlinux.com`, `/boot/config-*` inside `kernel-6.1.188-233.386.amzn2023.{x86_64,aarch64}.rpm` and `kernel6.12-6.12.110-135.202.amzn2023.{x86_64,aarch64}.rpm`, all four identical on these lines):
  ```
  CONFIG_TRANSPARENT_HUGEPAGE=y
  # CONFIG_TRANSPARENT_HUGEPAGE_ALWAYS is not set
  CONFIG_TRANSPARENT_HUGEPAGE_MADVISE=y
  # CONFIG_TRANSPARENT_HUGEPAGE_NEVER is not set     (6.12 only; option absent in 6.1)
  ```
  So the compiled-in boot default of `/sys/kernel/mm/transparent_hugepage/enabled` is **`madvise`** (shown as `always [madvise] never`), and `defrag` is the upstream default **`madvise`** — unless the AMI's kernel command line, a sysctl/tmpfiles drop-in, or `tuned` overrides it, which the docs do not describe (NOT FOUND IN DOCS). The upstream Kconfig default would have been `always`; AL2023 deliberately selects `madvise`.

### 3.2 Kernel series and AMI names

Source: https://docs.aws.amazon.com/linux/al2023/ug/kernel-update.html (verbatim):

> Starting August 17, 2026, the default kernel for AL2023 will change from 6.1 to 6.18. New instances launched from the `al2023-ami-kernel-default` AMIs will boot kernel 6.18. Already-running instances are not affected and will keep the kernel they booted with. To stay on a specific kernel version, launch from version-specific AMIs such as `al2023-ami-kernel-6.1`.

> AL2023 was originally released in March 2023 with kernel 6.1. In April 2025, AL2023 added support for Linux kernel 6.12. … In March 2026, AL2023 added support for Linux kernel 6.18.

> AL2023 now updates the default kernel to the latest version annually. The `al2023-ami-kernel-default` AMIs will move to the latest LTS kernel.

SSM parameter names ("The SSM keys to query start with `/aws/service/ami-amazon-linux-latest/` followed by one of"): `al2023-ami-kernel-6.18-arm64`, `al2023-ami-minimal-kernel-6.18-arm64`, `al2023-ami-kernel-6.18-x86_64`, `al2023-ami-minimal-kernel-6.18-x86_64`; `al2023-ami-kernel-6.12-arm64`, `al2023-ami-minimal-kernel-6.12-arm64`, `al2023-ami-kernel-6.12-x86_64`, `al2023-ami-minimal-kernel-6.12-x86_64`; `al2023-ami-kernel-6.1-arm64`, `al2023-ami-minimal-kernel-6.1-arm64`, `al2023-ami-kernel-6.1-x86_64`, `al2023-ami-minimal-kernel-6.1-x86_64`; and `al2023-ami-kernel-default-*` ("The `al2023-ami-kernel-default-*` SSM parameters resolve to the AMI that runs the latest kernel version."). Package names: `kernel` (6.1), `kernel6.12`, `kernel6.18`; tools: "kernel-tools and kernel-tools-devel must be removed and reinstalled together" using `kernel${VERSION}-tools` (i.e. `kernel-tools`, `kernel6.12-tools`, `kernel6.18-tools`); `perf`, `perf6.12`, `perf6.18`. "We recommend that you upgrade to the latest AL2023 kernel 6.18, although all other AL2023 kernels are still supported." "Currently, only the cryptography in kernel 6.1 has completed FIPS 140-3 validation".

### 3.3 Package availability (nvme-cli, util-linux/fincore, kernel-tools/cpupower, numactl, tuned)

Source: AL2023 x86_64 `core` repository metadata, `https://cdn.amazonlinux.com/al2023/core/guids/5775d799…/x86_64/repodata/{primary,filelists,comps}.xml.gz` (mirror list `https://cdn.amazonlinux.com/al2023/core/mirrors/latest/x86_64/mirror.list`, fetched 2026-10-09). The docs page `all-packages-AL2023.x.html` renders client-side and could not be read.

| package | present | newest version seen | ships |
| --- | --- | --- | --- |
| `nvme-cli` | yes | 1.11.1-3.amzn2023.0.3 | `/usr/sbin/nvme` |
| `util-linux` | yes | 2.37.4-1.amzn2023.0.3 | `/usr/bin/fincore`, `/usr/bin/lscpu` |
| `util-linux-core` | yes | 2.37.4 | — |
| `kernel-tools` | yes | 6.1.x (e.g. 6.1.10-15.42 … latest matches kernel) | `/usr/bin/cpupower`, `/usr/bin/turbostat` |
| `kernel6.12-tools`, `kernel6.18-tools` | yes | 6.12.x / 6.18.x | `/usr/bin/cpupower`, `/usr/bin/turbostat` |
| `numactl`, `numactl-libs` | yes | 2.0.14-3.amzn2023.0.3 | `/usr/bin/numactl` |
| `tuned` | yes | 2.25.1-2.amzn2023.0.2 (noarch) | `/usr/sbin/tuned-adm` |
| `tuned-profiles*` | no (no such package) | — | — |
| `perf` / `perf6.12` / `perf6.18` | yes | — | `/usr/bin/perf` |
| `stress-ng` 0.15.05, `hwloc` 2.4.1 (`lstopo` in `hwloc-gui`), `sysstat` 12.5.6, `fio` 3.32, `chrony` 4.3 | yes | — | — |
| `msr-tools` (`rdmsr`/`wrmsr`) | **no** | — | — |

`comps.xml` groups: `kernel-tools` is **mandatory** in the `ami` and `base` groups (6.1), but is *not* listed in `ami-kernel6.12` / `ami-kernel6.18` groups; `util-linux` and `chrony` are mandatory in every `ami*`/`base*` group; `sysstat` is `default` in `ami`/`base`; `tuned`, `nvme-cli`, `numactl`, `hwloc` appear in **no** group. The AL2023 kernel-hardening page says "The `CONFIG_X86_MSR` option is enabled in order to support `turbostat`."

### 3.4 Does AL2023 enable `tuned` or a CPU governor by default?

- Docs: **NOT FOUND IN DOCS.** https://docs.aws.amazon.com/linux/al2023/ug/performance-optimizations.html lists only compiler flags, ENA/EFA drivers, live patching, package versioning; no `tuned`, governor, THP or clocksource statements. `tuned` is not in any comps group (3.3), so it is not part of the AMI package set by default.
- Kernel config (same RPMs as 3.1, x86_64 and aarch64, 6.1 and 6.12): `CONFIG_CPU_FREQ_DEFAULT_GOV_PERFORMANCE=y` (compiled-in default governor `performance`; `powersave`/`userspace`/`ondemand`/`conservative` are modules `=m`, `schedutil=y`); `CONFIG_X86_INTEL_PSTATE=y` (6.1 and 6.12 x86_64); `# CONFIG_X86_AMD_PSTATE is not set` in **6.1** x86_64 but `CONFIG_X86_AMD_PSTATE=y` with `CONFIG_X86_AMD_PSTATE_DEFAULT_MODE=3` in **6.12** x86_64 (upstream `drivers/cpufreq/Kconfig.x86`: "1 -> Disabled 2 -> Passive 3 -> Active (EPP) 4 -> Guided"); `CONFIG_INTEL_IDLE=y`, `CONFIG_ACPI_PROCESSOR_IDLE=y`, `CONFIG_CPU_IDLE_GOV_MENU=y`, `CONFIG_CPU_IDLE_GOV_LADDER=y`, `CONFIG_CPU_IDLE_GOV_HALTPOLL=y` (x86), `# CONFIG_CPU_IDLE_GOV_TEO is not set`; `CONFIG_HZ=100` (also documented: "AL2023 sets `CONFIG_HZ` to 100 on both `x86-64` and `aarch64` platforms."); `CONFIG_NO_HZ_FULL=y`; `CONFIG_RCU_NOCB_CPU=y`; `CONFIG_CPU_ISOLATION=y`; `CONFIG_NUMA_BALANCING=y` + `CONFIG_NUMA_BALANCING_DEFAULT_ENABLED=y`; `CONFIG_SCHED_AUTOGROUP=y`; `# CONFIG_KSM is not set` (so `/sys/kernel/mm/ksm/` will not exist); `# CONFIG_COMPAT_BRK is not set` (docs: "the `randomize_va_space` `sysctl` setting defaults to `2`"); `CONFIG_CPU_MITIGATIONS=y`; `CONFIG_PREEMPT_NONE=y` (+ `CONFIG_PREEMPT_DYNAMIC=y` on x86_64); `CONFIG_SCHED_SMT=y` on x86_64, `# CONFIG_SCHED_SMT is not set` on aarch64.

### 3.5 AL2023 clocksource guidance on Nitro

**NOT FOUND IN DOCS** (no AL2023 user-guide or release-note page mentions clocksource/tsc/kvm-clock). The general EC2 guidance is the re:Post article in 1.4.

---

## 4. Graviton on Linux

- `lscpu` threads per core: an explicit "Thread(s) per core: 1" line is **NOT FOUND IN DOCS**. The Graviton guide's `Monitoring_Tools_on_Graviton.md` shows an abbreviated `lscpu` table (Architecture aarch64; CPU(s) 64; On-line CPU(s) list 0-63; L1d 4 MiB (64 instances); NUMA node(s) 1) without the threads line. The 1:1 mapping is stated in prose (1.3) and encoded in `perfrunbook/utilities/configure_vcpus.sh`: `if [[ "$2" == "threads" && $(uname -m) == "aarch64" ]]; then echo "Can only specify 'cores' for hotplugging cpus on Graviton"`.
- `/sys/devices/system/cpu/cpufreq` on Graviton: **NOT FOUND IN DOCS** (no hit for `cpufreq`, `governor`, `frequency scaling` anywhere in aws/aws-graviton-getting-started; AWS says only "operate at a fixed frequency"). Supporting evidence (source, not doc): the AL2023 aarch64 kernels (6.1.188, 6.12.110) have `CONFIG_CPU_FREQ=y` but **no cpufreq platform driver** (`# CONFIG_ACPI_CPPC_CPUFREQ is not set`, `# CONFIG_CPUFREQ_DT is not set`); `drivers/cpufreq/cpufreq.c` `cpufreq_core_init()` creates the global `cpufreq` kobject unconditionally (`kobject_create_and_add("cpufreq", &dev_root->kobj)`), while per-CPU `cpuN/cpufreq` symlinks are only added when a policy exists (`add_cpu_dev_symlink`). Expectation on AL2023/Graviton: `/sys/devices/system/cpu/cpufreq/` exists but is empty, no `policyN`, no `cpuN/cpufreq`, no `scaling_governor`. Frequency can only be read via `dmidecode` per the Graviton guide.
- cpuidle on Graviton: **NOT FOUND IN DOCS** for whether states are exposed. AL2023 aarch64 kernels build `CONFIG_CPU_IDLE=y`, `CONFIG_ARM_PSCI_CPUIDLE=y`, `CONFIG_ARM_PSCI_CPUIDLE_DOMAIN=y`, `CONFIG_CPU_IDLE_GOV_MENU=y`, `CONFIG_CPU_IDLE_GOV_LADDER=y`; `CONFIG_ARM_CPUIDLE` (the `arm_idle` driver) is not set. If the firmware exposes LPI/PSCI states, `current_driver` would read **`psci-cpuidle`** and `state0/name` = `WFI`; AWS's statement that the OS cannot control C-states on Graviton suggests only WFI (or no cpuidle directory) is exposed. There is no `psci_idle` driver name in the kernel.
- Clocksource on Graviton: re:Post (1.4): "All AWS Graviton processors use arch_sys_counter as the clock source." (`CONFIG_ARM_ARCH_TIMER=y` in the AL2023 aarch64 config.)
- THP recommendation from the Graviton guide (`perfrunbook/optimization_recommendation.md`): "Enable Transparent Huge Pages (THP) `echo always > /sys/kernel/mm/transparent_hugepage/enabled` -or- `echo madvise > /sys/kernel/mm/transparent_hugepage/enabled`"; it also recommends `systemctl stop irqbalance` and pinning ENA IRQs via `/proc/irq/$i/smp_affinity_list`, and disabling RPS. `linux_kernel.md`: "Starting with Linux kernel 7.0, the default preemption model changed from `PREEMPT_NONE` to `PREEMPT_LAZY`" — "Use a Linux distribution that defaults to `PREEMPT_NONE` on kernel 7.0+."
- Minimum kernels (`os.md`): "Amazon Linux 2023: All supported kernels"; "Graviton5 does not support Amazon Linux 2 kernel 4.14.x".

# The zone is the Availability Zone ID

_Changed by ADR-0029: a Series is keyed on the zone ID, which every Run records beside the zone name; `schedule.json` and the launch still name the zone._

A Machine's identity holds the account-independent Availability Zone ID (`use1-az1`), observed from the metadata service and requested at launch by ID, rather than the Availability Zone name (`us-east-1a`). The name was rejected because in nine older Regions it is a per-account label for accounts created before November 2025, so a Ledger keyed on names could neither be compared with nor reproduced from another account. The cost is that readers used to zone names must look the mapping up, and the project's own earlier code and configuration, written in names, must change.

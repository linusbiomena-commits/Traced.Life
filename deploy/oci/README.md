# TRACED on Oracle Cloud: deployment scripts

Plan, costs and decisions: `docs/deploy/oci-plan.md`. These scripts never print secrets.

The admin scripts run from Git Bash on the admin PC with the OCI CLI session profile `TRACED`:

```
oci session authenticate --region me-riyadh-1 --profile-name TRACED   # browser sign-in
oci session refresh --profile TRACED                                  # extend (about 1 h)
```

## Admin PC scripts (`deploy/oci/`)

| Script | Purpose | State |
|---|---|---|
| `lib.sh` | shared helpers (session profile, compartment lookup, `.work/` for temporary files) | n/a |
| `create-network.sh` | VCN `traced-vcn` 10.20.0.0/16, internet gateway (outbound), route table, security list and NSG with **no ingress**; empties the VCN default list | **applied 27 Nov 2026** |
| `create-secrets.sh` | generates 9 secrets locally and stores them in `traced-vault` (software key `traced-master-key`) | **applied** |
| `create-buckets.sh` | `TRACED-Services-Policy`; buckets `traced-db-backups` (35-day lifecycle) and `traced-audit-checkpoints` (400-day retention rule, **unlocked**), both private and encrypted with `traced-master-key` | **applied** |
| `launch-vm.sh` | `traced-app-1`: A1.Flex 1 OCPU / 4 GB, 50 GB boot, Ubuntu 24.04 aarch64, no SSH key, no inbound ports, Run Command agent | **applied 27 Nov 14:08 UTC** (after the Pay As You Go upgrade) |
| `reserve-ip.sh` | reserved public IP `traced-api-ip` (free) on the server's primary private IP, replacing the ephemeral one | **applied 27 Nov: 84.13.153.140** |
| `create-proxy-secret.sh` | generates `traced-proxy-secret` into Vault (never printed) | **applied 27 Nov** |
| `store-resend-key.ps1` | **owner runs it**: stores the Resend key in Vault with hidden input | waiting for the owner |
| `open-web-ports.sh` | NSG ingress TCP 443 + 80 only | **applied 27 Nov (Phase 8C)** |
| `create-monitoring.sh` | topic `traced-ops-alerts`, email subscription, 7 alarms | **applied 27 Nov** (subscription to be confirmed by email) |
| `vmrun.sh` | runs a `vm/` script on the VM as root through OCI Run Command; output via `traced-db-backups/ops/out/` | needs the VM |

`TRACED-Workload-Policy` also allows the VM to run Run Command scripts on itself:
`use instance-agent-command-execution-family ... where request.instance.id = target.instance.id`.

## VM scripts (`deploy/oci/vm/`), in order, after the VM is running

```
V=$(source deploy/oci/lib.sh; vault_id); NS=$(source deploy/oci/lib.sh; os_ns)
deploy/oci/vmrun.sh vm/vm_01_db.sh $V                  # PostgreSQL 18 container, traced_migrator, database traced
deploy/oci/vmrun.sh vm/vm_02_migrate.sh $V <commit>    # build API image at <commit>, migrate twice, production-roles.sql
deploy/oci/vmrun.sh vm/vm_03_verify.sh $V              # schema, checksums, audit chain, role denials, exposure
deploy/oci/vmrun.sh vm/vm_04_backup_install.sh $V $NS  # nightly encrypted backup timer + restore check
deploy/oci/vmrun.sh vm/vm_05_backup_test.sh           # one backup now + full restore check
deploy/oci/vmrun.sh vm/vm_06_harden.sh                # disable ssh/rpcbind
# PREPARED, NOT RUN (needs approval + domain + Resend key in Vault + proxy secret + NSG 443):
deploy/oci/vmrun.sh vm/vm_07_api_install.sh $V $NS <commit> <api-host> <app-origin> '<mail-from>'
```

`vm_00_status.sh`: read-only status. **Ran on the server 27 Nov:** `vm_00`–`vm_06` (results in `docs/deploy/oci-hosting-report.md`).

- `vm/cloud-init.yaml`: Docker, PostgreSQL client, gpg, the OCI CLI (instance principal), unattended upgrades, and sudo for the Run Command user.
- The database container publishes no port and sits on an internal Docker network.
- The superuser password is used only at first initialisation, from tmpfs, and is not kept in the container configuration.

## Tested locally (27 Nov 2026)

- `server/test/oci-db-layout.test.ts` (8 tests) reproduces the VM database layout on a dedicated PostgreSQL 18 cluster:
  - the non-superuser `traced_migrator` owns and migrates the schema, and a second run verifies checksums;
  - `production-roles.sql` applied by the superuser;
  - runtime roles log in with passwords and are refused evidence changes, DDL, role switching and `COPY TO PROGRAM`;
  - the read-only role is refused writes and personal-data tables;
  - outsider roles cannot connect;
  - the restore-check row-count query works.
- All scripts pass `bash -n`.

## Not tested locally

There is no Docker or `psql` on the admin PC, so these were not run here:
- the `psql` meta-commands (`\getenv`, `\gexec`);
- the Docker steps;
- cloud-init;
- the ARM image build;
- gpg;
- systemd.

They run for the first time on the VM. Check each step's output, and stop at the first failure.

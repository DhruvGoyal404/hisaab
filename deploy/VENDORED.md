# Vendored from Chitthi

The shared host (the VM `apps-vm` and its edge Caddy) is defined in
[DhruvGoyal404/chitthi](https://github.com/DhruvGoyal404/chitthi). Hisaab keeps exact copies of
the files it needs, pinned to one Chitthi commit, so its scripts never depend on the other repo at
run time (docs/PHASE7-PLAN.md, section 2).

Pinned commit: `fafd9c28b0426d4b7f861c1b022fdf26db6f8760` (chitthi#1, squash-merged)

| Here | In Chitthi |
|---|---|
| `deploy/edge/compose.yaml` | `deploy/edge/compose.yaml` |
| `deploy/edge/Caddyfile` | `deploy/edge/Caddyfile` |
| `deploy/host/edge.sh` | `deploy/host/edge.sh` (only `test-deploy.sh` runs it; on the VM the edge is Chitthi's to install) |
| `deploy/azure/lib.sh`, `host-up.sh`, `host-down.sh`, `audit.jq`, `run-on-vm.sh`, `age_keypair.py` | the same paths |

CI (`images` job, "Vendored files match Chitthi") fetches each file at the pinned commit and fails
on any difference. To update: change the commit above and in `scripts/check-vendored.sh`, copy the
files again, and let CI confirm.

Hisaab's own files next to them are not vendored: `deploy/edge/hisaab.caddy` is Hisaab's site file,
installed on the VM as `/srv/edge/sites/hisaab.caddy` by Hisaab's deploy only.

Adapted, not vendored (the same design with Hisaab's names): `deploy/host/deploy.sh`, `backup.sh`,
`status.sh`, `test-deploy.sh`, `deploy/azure/setup.sh`, `public-check.sh`, `hisaab-up.sh`,
`hisaab-down.sh` and `.github/workflows/deploy.yml`. `deploy/azure/app.sh` holds Hisaab's names, so
the vendored `lib.sh` stays an exact copy.

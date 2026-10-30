# Vendored from Chitthi

The shared host (the VM `apps-vm` and its edge Caddy) is defined in
[DhruvGoyal404/chitthi](https://github.com/DhruvGoyal404/chitthi). Hisaab keeps exact copies of
the files it needs, pinned to one Chitthi commit, so its scripts never depend on the other repo at
run time (docs/PHASE7-PLAN.md, section 2).

Pinned commit: `4b24b49eb2047f3a85e4b434718176ccdd5c08b9`

| Here | In Chitthi |
|---|---|
| `deploy/edge/compose.yaml` | `deploy/edge/compose.yaml` |
| `deploy/edge/Caddyfile` | `deploy/edge/Caddyfile` |
| `deploy/host/edge.sh` | `deploy/host/edge.sh` (only `test-deploy.sh` runs it; on the VM the edge is Chitthi's to install) |

CI (`images` job, "Vendored files match Chitthi") fetches each file at the pinned commit and fails
on any difference. To update: change the commit above and in `scripts/check-vendored.sh`, copy the
files again, and let CI confirm.

Hisaab's own files next to them are not vendored: `deploy/edge/hisaab.caddy` is Hisaab's site file,
installed on the VM as `/srv/edge/sites/hisaab.caddy` by Hisaab's deploy only.

`deploy/host/deploy.sh` and `test-deploy.sh` are adapted, not vendored: the same design with
Hisaab's names, its own users and folders, and no `CHITTHI_*` settings.

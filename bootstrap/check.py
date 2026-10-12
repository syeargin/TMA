"""CI check for the bootstrap template (risk R1: environments must not reach each other).

- github-oidc.yaml must be exactly what build.py produces.
- Every dev resource names only dev things, and every prod resource only prod things.
- No role grants on "<prefix>-*", which would match both environments (except the old shared
  execution role, kept only while stacks switch over).
"""
import pathlib, re, subprocess, sys, yaml

here = pathlib.Path(__file__).parent
built = subprocess.run([sys.executable, str(here / "build.py")], capture_output=True, text=True, check=True).stdout
if built != (here / "github-oidc.yaml").read_text():
    sys.exit("bootstrap/github-oidc.yaml is out of date: run  python3 bootstrap/build.py > bootstrap/github-oidc.yaml")

class Loader(yaml.SafeLoader): pass
def tag(loader, suffix, node):
    if isinstance(node, yaml.SequenceNode): return {suffix: loader.construct_sequence(node, deep=True)}
    if isinstance(node, yaml.MappingNode): return {suffix: loader.construct_mapping(node, deep=True)}
    return {suffix: loader.construct_scalar(node)}
Loader.add_multi_constructor("!", tag)
resources = yaml.load(built, Loader=Loader)["Resources"]

problems = []
for name, res in resources.items():
    text = yaml.safe_dump(res)
    for env, other in (("Dev", "prod"), ("Prod", "dev")):
        if name.startswith(env) and re.search(rf"\b{other}\b", text):
            problems.append(f"{name} mentions {other}")
    if name != "CfnExecutionRole":
        for wide in re.findall(r"\$\{AppPrefix\}-\*|TeamHub-\*", text):
            problems.append(f"{name} grants on {wide}, which matches every environment")
for env in ("Dev", "Prod"):
    for kind in ("Boundary", "ExecRole", "DeployRole"):
        if env + kind not in resources:
            problems.append(f"missing {env}{kind}")
if problems:
    sys.exit("\n".join(problems))
print(f"bootstrap ok: {len(resources)} resources, environments kept apart")

"""python tests/text/sweep/show.py [out dir] [doc substring] [per kind]: a sample of the sweep failures"""
import collections
import json
import sys

out = sys.argv[1] if len(sys.argv) > 1 else ".tmp/boxes/out"
want = sys.argv[2] if len(sys.argv) > 2 else ""
limit = int(sys.argv[3]) if len(sys.argv) > 3 else 3
seen = collections.Counter()
for f in json.load(open(f"{out}/failures.json", encoding="utf-8")):
    if want not in f["doc"]:
        continue
    k = (f["doc"], f["check"])
    seen[k] += 1
    if seen[k] <= limit:
        line = f'{f["doc"]} {f["page"]} {f["box"][:34]!r} {f["check"]} {f["detail"][:210]}'
        sys.stdout.buffer.write((line + "\n").encode("utf-8"))
print(sum(seen.values()), "failures;", dict(collections.Counter(c for (_, c), n in seen.items() for _ in range(n))))

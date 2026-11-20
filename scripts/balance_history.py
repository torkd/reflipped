#!/usr/bin/env python3
"""Walk the CDN's diff archives for unit balance changes (FT-47, docs/balance-history.md).

Every diff archive (`asset-A-B-n-hash.zip`) holds the whole new version of each table it changed, so a table's history
in the CDN window is its copy in the full archives (counted as 2.1.0) followed by every diff that carries it. This
script reads each copy of the balance tables in version order and reports, per version and with the archive's date:

  - character/character_status: units whose HP/ATK changed, and units added;
  - mana_board/mana_node: units that gained a second mana board (existing units, and new units released with one);
  - skill/action_skill: skills whose numbers changed (the name and text columns, 0 and 1, are left out: they change
    when a Japanese text is translated);
  - ability/ability, ability/leader_ability: rows whose non-text columns changed; a version that changes the row
    length (a new column layout) is reported as such, with the rows compared after mapping the layout (see --layout);
  - character/character: units added.

Usage (from the repository root, CDN in `.cdn/` or `CDN_DIR`):
  python3 -I scripts/balance_history.py > balance-history.json
  python3 -I scripts/balance_history.py --summary

The output holds IDs, versions, dates and changed values: findings to write up, not game data to commit.
"""
import argparse
import datetime
import importlib.util
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.realpath(__file__))
spec = importlib.util.spec_from_file_location("extract_master", os.path.join(HERE, "extract_master.py"))
em = importlib.util.module_from_spec(spec)
spec.loader.exec_module(em)

TABLES = ["character/character", "character/character_status", "mana_board/mana_node", "skill/action_skill",
          "ability/ability", "ability/leader_ability"]


def archive_copies(root, path):
    """Every archive copy of an asset path: [(version, zip_path, member, date)], oldest version first."""
    members = set(em.digest_paths(path))
    copies = {}
    for category in sorted(os.listdir(root)):
        folder = os.path.join(root, category)
        if not category.startswith("archive-") or not os.path.isdir(folder):
            continue
        for name in os.listdir(folder):
            m = em.ARCHIVE_RE.match(name)
            if not m:
                continue
            version = em.parse_version(m.group(2) or m.group(1))
            zip_path = os.path.join(folder, name)
            try:
                with zipfile.ZipFile(zip_path) as z:
                    for info in z.infolist():
                        if info.filename in members:
                            copies.setdefault(version, (zip_path, info.filename, datetime.datetime(*info.date_time).date().isoformat()))
            except zipfile.BadZipFile:
                continue
    return [(version, *copies[version]) for version in sorted(copies)]


def read_copy(zip_path, member):
    with zipfile.ZipFile(zip_path) as z:
        return em.read_orderedmap(z.read(member))


def vstr(version):
    return ".".join(map(str, version))


def diff_status(old, new):
    return {"changed": {k: {"before": old[k], "after": new[k]} for k in old if k in new and old[k] != new[k]},
            "added": [k for k in new if k not in old]}


def diff_mana(old, new):
    return {"board2_existing": sorted(k for k in new if k in old and "2" in new[k] and "2" not in old[k]),
            "board2_with_release": sorted(k for k in new if k not in old and "2" in new[k]),
            "added_without_board2": sorted(k for k in new if k not in old and "2" not in new[k]),
            "board2_removed": sorted(k for k in old if k in new and "2" in old[k] and "2" not in new[k])}


def diff_skill(old, new):
    changed = {}
    for key in old:
        if key not in new or old[key] == new[key]:
            continue
        levels = {}
        for level, row in old[key].items():
            after = new[key].get(level)
            if after is None or row[2:] == after[2:]:
                continue
            levels[level] = [[i, row[i], after[i]] for i in range(2, min(len(row), len(after))) if row[i] != after[i]]
        if levels:
            changed[key] = levels
    return {"changed": changed, "added": [k for k in new if k not in old]}


def is_text(value):
    """A column worth ignoring in a comparison: words (names and descriptions, which translation changes)."""
    return any(ch.isalpha() and ord(ch) > 0x7f for ch in value) or " " in value.strip()


def layout_map(old_rows, new_rows):
    """
    Maps an old row layout onto a new one with inserted columns (a version that changed the layout): an order-keeping
    alignment of old columns to new columns that maximises how often their values agree across the rows (dynamic
    programming, like a sequence alignment). Returns (rows equal after mapping, {new index: old index}, inserted new
    indexes).
    """
    shared = [k for k in old_rows if k in new_rows and isinstance(old_rows[k], list)]
    if not shared:
        return None
    old_len, new_len = max(((len(old_rows[k]), len(new_rows[k])) for k in shared),
                           key=lambda pair: sum(1 for k in shared if (len(old_rows[k]), len(new_rows[k])) == pair))
    rows = [k for k in shared if (len(old_rows[k]), len(new_rows[k])) == (old_len, new_len)]
    # how often old column i equals new column j; a column of one repeated value says little, so weight by variety
    agree = [[sum(old_rows[k][i] == new_rows[k][j] for k in rows) / len(rows) for j in range(new_len)] for i in range(old_len)]
    best = [[0.0] * (new_len + 1) for _ in range(old_len + 1)]
    for i in range(old_len - 1, -1, -1):
        for j in range(new_len - 1, -1, -1):
            best[i][j] = max(best[i + 1][j], best[i][j + 1], agree[i][j] + best[i + 1][j + 1])
    mapping = {}
    i = j = 0
    while i < old_len and j < new_len:
        if best[i][j] == agree[i][j] + best[i + 1][j + 1] and agree[i][j] > 0.5:
            mapping[j] = i
            i += 1
            j += 1
        elif best[i][j] == best[i][j + 1]:
            j += 1
        else:
            i += 1
    equal = sum(all(new_rows[k][n] == old_rows[k][o] for n, o in mapping.items()) for k in rows)
    return equal, mapping, [j for j in range(new_len) if j not in mapping]


def diff_ability(old, new):
    shared = [k for k in old if k in new]
    lengths = {(len(old[k]), len(new[k])) for k in shared if isinstance(old[k], list)}
    result = {"added": [k for k in new if k not in old]}
    # a new layout: most rows change length the same way
    grown = [b - a for a, b in lengths if b != a]
    if grown and len([k for k in shared if isinstance(old[k], list) and len(new[k]) != len(old[k])]) > len(shared) // 2:
        a, b = max(lengths, key=lambda pair: sum(1 for k in shared if isinstance(old[k], list) and (len(old[k]), len(new[k])) == pair))
        best = layout_map(old, new)
        result["layout"] = {"from": a, "to": b, "inserted_at": best[2], "inserted": b - a, "unmapped_old": a - len(best[1]),
                            "rows_equal_after_mapping": best[0]}
        mapping = best[1]
    else:
        mapping = None
    changed = {}
    for k in shared:
        o, n = old[k], new[k]
        if not isinstance(o, list):
            continue
        pairs = [(i, mapping[i]) for i in sorted(mapping)] if mapping else [(i, i) for i in range(max(len(o), len(n)))]
        pairs = [(ni, oi) for ni, oi in pairs if ni < len(n) and oi < len(o)]
        cols = [[ni, o[oi], n[ni]] for ni, oi in pairs if o[oi] != n[ni] and not (is_text(o[oi]) and is_text(n[ni]))]
        if cols:
            changed[k] = cols
    result["changed"] = changed
    return result


def diff_character(old, new):
    return {"added": [k for k in new if k not in old]}


DIFFS = {"character/character": diff_character, "character/character_status": diff_status, "mana_board/mana_node": diff_mana,
         "skill/action_skill": diff_skill, "ability/ability": diff_ability, "ability/leader_ability": diff_ability}


def walk(root, table):
    copies = archive_copies(root, em.table_path(table))
    steps = []
    previous = None
    for version, zip_path, member, date in copies:
        data = read_copy(zip_path, member)
        if previous is not None:
            change = DIFFS[table](previous[1], data)
            if any(change.values()):
                steps.append({"from": vstr(previous[0]), "version": vstr(version), "date": date, **change})
        else:
            steps.append({"version": vstr(version), "date": date, "base": True, "rows": len(data)})
        previous = (version, data)
    return steps


def summary(history):
    lines = []
    for table, steps in history.items():
        lines.append(f"== {table}")
        for step in steps:
            if step.get("base"):
                lines.append(f"  {step['version']} ({step['date']}): base, {step['rows']} rows")
                continue
            parts = []
            for key, value in step.items():
                if key in ("from", "version", "date"):
                    continue
                if key == "layout":
                    parts.append(f"layout {value['from']}->{value['to']} columns (new columns {value['inserted_at']}, "
                                 f"{value['unmapped_old']} old unmapped, {value['rows_equal_after_mapping']} rows equal)")
                elif value:
                    parts.append(f"{key} {len(value)}")
            lines.append(f"  {step['version']} ({step['date']}): {', '.join(parts)}")
    return "\n".join(lines)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cdn", default=os.environ.get("CDN_DIR", ".cdn"))
    parser.add_argument("--region", default="en")
    parser.add_argument("--summary", action="store_true", help="one line per version instead of the full JSON")
    parser.add_argument("--table", action="append", help="only these tables (default: all balance tables)")
    args = parser.parse_args()
    root = os.path.join(args.cdn, args.region)
    history = {table: walk(root, table) for table in (args.table or TABLES)}
    print(summary(history) if args.summary else json.dumps(history, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()

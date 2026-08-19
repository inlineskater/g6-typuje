#!/usr/bin/env python3
"""Move a contiguous region of index.html's inline script into tabs/<name>.js.

Safety model (mirrors what games/*.js already relies on):
  * the module owns its own top-level const/let  -> index.html must not keep any
  * functions it defines overwrite same-named stubs in index.html
  * anything it *reads* from index.html is fine (shared global lexical env)

The script refuses to move a region that would break either rule, and reports
which functions are called from outside (those are the entry points that must
go through withTabModule()).

Usage:
  extract-tab.py analyze <start-marker> <end-marker>
  extract-tab.py move    <name> <start-marker> <end-marker>
"""
import re, sys, os

ROOT = '/Users/yuriishavlov/projects/rynek-proroctw'
IDX = os.path.join(ROOT, 'index.html')


def load():
    return open(IDX, encoding='utf-8').read().split('\n')


def find_bounds(lines, start_marker, end_marker):
    s = e = None
    for i, ln in enumerate(lines):
        if s is None and start_marker in ln:
            s = i
        elif s is not None and end_marker in ln:
            e = i
            break
    if s is None:
        sys.exit('start marker not found: ' + start_marker)
    if e is None:
        sys.exit('end marker not found: ' + end_marker)
    return s, e  # region = lines[s:e]


def analyze(lines, s, e):
    region = '\n'.join(lines[s:e])
    outside = '\n'.join(lines[:s] + lines[e:])

    funcs = set(re.findall(r'^(?:async )?function ([A-Za-z_$][\w$]*)', region, re.M))
    decls = set(re.findall(r'^(?:const|let|var) ([A-Za-z_$][\w$]*)', region, re.M))

    called_out = sorted(f for f in funcs
                        if re.search(r'\b' + re.escape(f) + r'\s*\(', outside))
    decl_out = sorted(d for d in decls
                      if re.search(r'(?<![.\w$])' + re.escape(d) + r'(?![\w$])', outside))

    # top-level statements that execute on load (not plain declarations)
    side = [ln for ln in lines[s:e]
            if re.match(r'^[A-Za-z_$]', ln)
            and not re.match(r'^(const|let|var|function|async function)\b', ln)]

    # does index.html declare any name the region also declares? (fatal)
    dup = sorted(d for d in decls
                 if re.search(r'^(?:const|let|var) ' + re.escape(d) + r'\b', outside, re.M))

    return dict(lines=e - s, funcs=len(funcs), decls=len(decls),
                entry_points=called_out, decls_used_outside=decl_out,
                side_effects=side, duplicate_decls=dup)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    cmd = sys.argv[1]

    if cmd == 'analyze':
        lines = load()
        s, e = find_bounds(lines, sys.argv[2], sys.argv[3])
        r = analyze(lines, s, e)
        print(f"region lines {s+1}..{e}  ({r['lines']} lines, "
              f"{len(chr(10).join(lines[s:e]))} bytes)")
        print(f"  functions: {r['funcs']}   top-level const/let: {r['decls']}")
        print(f"  ENTRY POINTS (called from outside): {r['entry_points'] or 'none'}")
        print(f"  decls referenced outside (must stay!): {r['decls_used_outside'] or 'none'}")
        print(f"  duplicate decls in index.html (FATAL): {r['duplicate_decls'] or 'none'}")
        print(f"  top-level side effects: {len(r['side_effects'])}")
        for x in r['side_effects'][:8]:
            print('     ', x.strip()[:100])
        return

    if cmd == 'move':
        name, sm, em = sys.argv[2], sys.argv[3], sys.argv[4]
        lines = load()
        s, e = find_bounds(lines, sm, em)
        r = analyze(lines, s, e)
        if r['duplicate_decls']:
            sys.exit('REFUSING: duplicate declarations ' + str(r['duplicate_decls']))
        if r['decls_used_outside']:
            sys.exit('REFUSING: const/let used outside ' + str(r['decls_used_outside']))
        if r['side_effects']:
            sys.exit('REFUSING: top-level side effects (%d)' % len(r['side_effects']))

        body = '\n'.join(lines[s:e]).rstrip() + '\n'
        os.makedirs(os.path.join(ROOT, 'tabs'), exist_ok=True)
        hdr = ("// Lazy-loaded tab module — see ensureTabModule() in index.html.\n"
               "// Moved out of index.html's inline <script> so it is fetched only when\n"
               "// this tab is actually opened. Owns its own top-level const/let; reads\n"
               "// shared globals from index.html, which always runs first.\n"
               "'use strict';\n\n")
        out = os.path.join(ROOT, 'tabs', name + '.js')
        open(out, 'w', encoding='utf-8').write(hdr + body)

        marker = [
            "// %s moved to tabs/%s.js — loaded on demand by ensureTabModule('%s')."
            % (name, name, name),
            "// Entry point(s): %s" % (', '.join(r['entry_points']) or 'none'),
        ]
        lines[s:e] = marker
        open(IDX, 'w', encoding='utf-8').write('\n'.join(lines))
        print("moved %d lines -> tabs/%s.js  (entry: %s)"
              % (r['lines'], name, ', '.join(r['entry_points']) or 'none'))
        return

    sys.exit('unknown command ' + cmd)


main()

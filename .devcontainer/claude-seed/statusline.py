#!/usr/bin/env python3
import json, sys, subprocess, os, socket

# --- Load data ---
data = json.load(sys.stdin)

model  = data.get('model', {}).get('display_name', '?')
cwd    = data.get('workspace', {}).get('current_dir', os.getcwd())
cost   = (data.get('cost') or {}).get('total_cost_usd', 0) or 0
dur_ms = (data.get('cost') or {}).get('total_duration_ms', 0) or 0

ctx     = data.get('context_window') or {}
pct     = int(ctx.get('used_percentage', 0) or 0)

cur     = ctx.get('current_usage') or {}
cur_raw = cur.get('input_tokens', 0) or 0
cur_crd = cur.get('cache_read_input_tokens', 0) or 0
cur_ccr = cur.get('cache_creation_input_tokens', 0) or 0
cur_in  = cur_raw + cur_crd + cur_ccr
cur_out = cur.get('output_tokens', 0) or 0

limits  = data.get('rate_limits') or {}
lim_5h  = (limits.get('five_hour') or {}).get('used_percentage', 0) or 0
lim_7d  = (limits.get('seven_day') or {}).get('used_percentage', 0) or 0

session_id = data.get('session_id', '')

# --- Accumulate session + all-time totals ---
TOTALS_FILE = os.path.expanduser('~/.claude/token_totals.json')

try:
    with open(TOTALS_FILE) as f:
        totals = json.load(f)
except Exception:
    totals = {}

sess = totals.get('session') or {}
if sess.get('id') != session_id:
    # New session
    sess = {'id': session_id, 'in': 0, 'out': 0, 'requests': 0}

sess['in']       += cur_in
sess['out']      += cur_out
sess['requests'] += 1

alltime = totals.get('alltime') or {'in': 0, 'out': 0, 'requests': 0}
alltime['in']       += cur_in
alltime['out']      += cur_out
alltime['requests'] += 1

totals = {'session': sess, 'alltime': alltime}
try:
    with open(TOTALS_FILE, 'w') as f:
        json.dump(totals, f)
except Exception:
    pass

sess_in  = sess['in']
sess_out = sess['out']
all_in   = alltime['in']
all_out  = alltime['out']

# --- Colors ---
BOLD = '\033[1m'
BGRN = '\033[1;32m'
BBLU = '\033[1;34m'
CYAN = '\033[36m'
YLW  = '\033[33m'
GRN  = '\033[32m'
RED  = '\033[31m'
DIM  = '\033[2m'
RST  = '\033[0m'

# --- Helpers ---
def fmt(n):
    if n >= 1_000_000: return f"{n/1_000_000:.1f}M"
    if n >= 1_000:     return f"{n/1_000:.1f}k"
    return str(n)

def context_bar(pct):
    color  = RED if pct >= 90 else YLW if pct >= 70 else GRN
    filled = pct // 10
    return f"{color}{'█' * filled}{'░' * (10 - filled)}{RST}"

def git_branch():
    try:
        b = subprocess.check_output(
            ['git', 'branch', '--show-current'],
            text=True, stderr=subprocess.DEVNULL,
            env={**os.environ, 'GIT_OPTIONAL_LOCKS': '0'}
        ).strip()
        return f"  {DIM}on{RST} {CYAN}{b}{RST}" if b else ""
    except Exception:
        return ""

# --- Last request ---
cache_pct  = int(cur_crd / cur_in * 100) if cur_in > 0 else 0
cache_note = f" {DIM}({cache_pct}%💾){RST}" if cur_in > 0 else ""
last_str   = f"{BOLD}Last:{RST} {CYAN}↑{fmt(cur_in)}{cache_note} ↓{fmt(cur_out)}{RST}"

# --- Session ---
mins = dur_ms // 60000
secs = (dur_ms % 60000) // 1000
sess_str = f"{BOLD}Session:{RST} {CYAN}↑{fmt(sess_in)} ↓{fmt(sess_out)}{RST}  {YLW}${cost:.3f}{RST}  {DIM}{mins}m{secs:02d}s{RST}"

# --- All-time ---
all_str = f"{BOLD}Total:{RST} ↑{fmt(all_in)} ↓{fmt(all_out)}"

# --- Rate limits ---
def lim_color(p):
    return RED if p >= 90 else YLW if p >= 70 else GRN
rate_str = f"{BOLD}Quota:{RST} {lim_color(lim_5h)}{lim_5h}%{RST}{DIM}/5h{RST}  {lim_color(lim_7d)}{lim_7d}%{RST}{DIM}/7j{RST}"

# --- Output ---
user = os.getenv('USER') or os.getenv('LOGNAME') or 'user'
host = socket.gethostname().split('.')[0]

line1 = f"{BGRN}{user}@{host}{RST}:{BBLU}{cwd}{RST}  {DIM}[{model}]{RST}{git_branch()}"
line2 = f"{context_bar(pct)} {pct}%  {last_str}  {DIM}|{RST}  {sess_str}  {DIM}|{RST}  {all_str}  {DIM}|{RST}  {rate_str}"

print(line1)
print(line2)

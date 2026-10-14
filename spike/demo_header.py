"""Print header + start-script summary of Spring/Recoil .sdfz demos."""
import gzip, struct, sys, re, glob, os

HDR = "<16s i i 256s 16s q i i i i i i i i i i i i"  # through winningAllyTeamsSize

def read_header(path):
    with gzip.open(path, "rb") as f:
        raw = f.read(struct.calcsize(HDR))
        (magic, ver, hsize, verstr, gid, utime, script_sz, stream_sz, game_time, wall_time,
         nplayers, pstat_sz, pstat_elem, nteams, tstat_sz, tstat_elem, tstat_period, win_sz) = struct.unpack(HDR, raw)
        f.seek(hsize)
        script = f.read(script_sz).decode("utf-8", "replace")
    return dict(magic=magic.rstrip(b"\0"), version=ver, header_size=hsize,
                engine=verstr.split(b"\0")[0].decode(), game_id=gid.hex(), unix_time=utime,
                script_size=script_sz, stream_size=stream_sz, game_time=game_time,
                wall_time=wall_time, players=nplayers, teams=nteams, script=script)

def last_frame(path, h=None):
    """Last sim frame in the packet stream (NETMSG_KEYFRAME=1 carries int32 frameNum).
    Works for aborted demos whose header has gameTime=0. Returns -1 if the game never started."""
    h = h or read_header(path)
    last = -1
    with gzip.open(path, "rb") as f:
        f.seek(h["header_size"] + h["script_size"])
        while True:
            hd = f.read(8)  # chunk header: float modGameTime, uint32 length
            if len(hd) < 8:
                break
            _, ln = struct.unpack("<fI", hd)
            d = f.read(ln)
            if len(d) >= 5 and d[0] == 1:
                last = struct.unpack("<i", d[1:5])[0]
    return last


def field(script, key):
    m = re.search(r"(?im)^\s*" + key + r"\s*=\s*([^;]*);", script)
    return m.group(1).strip() if m else None

if __name__ == "__main__":
    paths = sys.argv[1:] or sorted(glob.glob(r"D:/Dmitrii/Beyond-All-Reason/data/demos/*.sdfz"))
    for p in paths:
        h = read_header(p)
        print(os.path.basename(p))
        print(f"  engine={h['engine']} game={field(h['script'],'gametype')} map={field(h['script'],'mapname')}")
        print(f"  gameId={h['game_id']} gameTime={h['game_time']}s players={h['players']} teams={h['teams']} stream={h['stream_size']}")
        print(f"  lastFrame={last_frame(p, h)}")

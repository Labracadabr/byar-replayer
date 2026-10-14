"""Minimal rapid (.sdp + pool) reader: list / extract files from a game package."""
import gzip, struct, sys, os, fnmatch

def read_sdp(sdp_path):
    data = gzip.open(sdp_path, "rb").read()
    i, out = 0, []
    while i < len(data):
        n = data[i]; i += 1
        name = data[i:i+n].decode("utf-8", "replace"); i += n
        md5 = data[i:i+16].hex(); i += 16
        crc, size = struct.unpack(">II", data[i:i+8]); i += 8
        out.append((name, md5, size))
    return out

def read_file(datadir, md5):
    return gzip.open(os.path.join(datadir, "pool", md5[:2], md5[2:] + ".gz"), "rb").read()

if __name__ == "__main__":
    datadir, sdp_hash, pattern = sys.argv[1], sys.argv[2], sys.argv[3]
    outdir = sys.argv[4] if len(sys.argv) > 4 else None
    for name, md5, size in read_sdp(os.path.join(datadir, "packages", sdp_hash + ".sdp")):
        if fnmatch.fnmatch(name.lower(), pattern.lower()):
            print(f"{size:>9} {name}")
            if outdir:
                dst = os.path.join(outdir, name); os.makedirs(os.path.dirname(dst), exist_ok=True)
                open(dst, "wb").write(read_file(datadir, md5))

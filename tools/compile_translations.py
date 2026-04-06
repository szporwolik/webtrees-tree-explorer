"""Compile PO files to MO binary format for webtrees custom module translations."""
import struct
import os
import re


def po_to_mo(po_path, mo_path):
    with open(po_path, "r", encoding="utf-8") as f:
        content = f.read()

    # Parse all entries including header
    all_entries = {}
    current_msgid = None
    current_msgstr = None
    in_msgid = False
    in_msgstr = False

    def flush():
        nonlocal current_msgid, current_msgstr, in_msgid, in_msgstr
        if current_msgid is not None and current_msgstr is not None:
            # Unescape PO string escapes
            mid = current_msgid.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
            mstr = current_msgstr.replace("\\n", "\n").replace('\\"', '"').replace("\\\\", "\\")
            all_entries[mid] = mstr
        current_msgid = None
        current_msgstr = None
        in_msgid = False
        in_msgstr = False

    for line in content.split("\n"):
        stripped = line.strip()

        if stripped.startswith("#"):
            continue

        if stripped == "":
            flush()
            continue

        if stripped.startswith("msgid "):
            if current_msgid is not None:
                flush()
            m = re.match(r'^msgid\s+"(.*)"$', stripped)
            current_msgid = m.group(1) if m else ""
            in_msgid = True
            in_msgstr = False
        elif stripped.startswith("msgstr "):
            m = re.match(r'^msgstr\s+"(.*)"$', stripped)
            current_msgstr = m.group(1) if m else ""
            in_msgid = False
            in_msgstr = True
        elif stripped.startswith('"') and stripped.endswith('"'):
            val = stripped[1:-1]
            if in_msgid and current_msgid is not None:
                current_msgid += val
            elif in_msgstr and current_msgstr is not None:
                current_msgstr += val

    flush()

    # Separate header from translations
    header_value = all_entries.pop("", "")
    # Only include entries with non-empty translations
    translations = {k: v for k, v in all_entries.items() if v}
    # Sort by msgid (MO format requires sorted keys)
    sorted_keys = sorted(translations.keys())
    # Prepend header entry (empty msgid)
    entries = [("", header_value)] + [(k, translations[k]) for k in sorted_keys]

    n = len(entries)
    header_size = 7 * 4  # 28 bytes
    table_size = n * 2 * 4  # each entry = 2 ints (length + offset)

    orig_table_offset = header_size
    trans_table_offset = header_size + table_size

    # Build string data
    orig_strings = b""
    trans_strings = b""
    orig_table = []
    trans_table = []

    for msgid, msgstr in entries:
        id_bytes = msgid.encode("utf-8")
        str_bytes = msgstr.encode("utf-8")
        orig_table.append((len(id_bytes), len(orig_strings)))
        orig_strings += id_bytes + b"\x00"
        trans_table.append((len(str_bytes), len(trans_strings)))
        trans_strings += str_bytes + b"\x00"

    strings_start_orig = header_size + 2 * table_size
    strings_start_trans = strings_start_orig + len(orig_strings)

    # Write MO file
    output = struct.pack(
        "Iiiiiii",
        0x950412DE,  # magic number
        0,  # revision
        n,  # number of strings
        orig_table_offset,
        trans_table_offset,
        0,  # hash table size
        0,  # hash table offset
    )

    for length, offset in orig_table:
        output += struct.pack("ii", length, strings_start_orig + offset)

    for length, offset in trans_table:
        output += struct.pack("ii", length, strings_start_trans + offset)

    output += orig_strings + trans_strings

    with open(mo_path, "wb") as f:
        f.write(output)

    print(f"  {os.path.basename(po_path)} -> {os.path.basename(mo_path)} ({len(translations)} translations)")


if __name__ == "__main__":
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    lang_dir = os.path.join(project_root, "resources", "lang")
    for lang in ["pl", "de", "es", "fr", "nl", "ru"]:
        po = os.path.join(lang_dir, f"{lang}.po")
        mo = os.path.join(lang_dir, f"{lang}.mo")
        if os.path.exists(po):
            po_to_mo(po, mo)
        else:
            print(f"  WARNING: {po} not found")
    print("Done!")

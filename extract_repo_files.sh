#!/bin/bash
# extract_repo_files.sh
# Usage: ./extract_repo_files.sh repo-pack.txt
PACK_FILE="$1"
DEST_DIR="org-main"
DELIM="=====FILE_DELIMITER====="
mkdir -p "$DEST_DIR"
# Read the packed file and split on the delimiter
# Each block: first line = path; rest = file contents
awk -v dest="$DEST_DIR" -v delim="$DELIM" '
{
  if ($0 == delim) {
    # end of one file block
    filePath = lines[1]
    # join the remaining lines back into the content
    content = ""
    for (i=2; i<=length(lines); i++) {
      content = content lines[i] "\n"
    }
    # write file
    outFile = dest "/" filePath
    cmd = "mkdir -p \"" dest "/" dirname(filePath) "\""
    system(cmd)
    print content > outFile
    close(outFile)
    # reset for next block
    delete lines
    count=0
  } else {
    count++
    lines[count] = $0
  }
}
' "$PACK_FILE"


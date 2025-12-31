import os
import re
import json
import glob

# Configuration
NCE_DIRS = ['NCE1', 'NCE2', 'NCE3', 'NCE4']
OUTPUT_FILE = 'static/search_index.json'

# Regex for parsing LRC
# Matches timestamps like [00:12.34]
TIME_RE = re.compile(r'\[\d+:\d+(?:\.\d+)?\]')
# Matches metadata like [ti:Title]
META_RE = re.compile(r'^\[(al|ar|ti|by):(.+)\]$', re.IGNORECASE)

def parse_lrc(file_path):
    """
    Parses a single LRC file and returns a list of sentence objects.
    Each object contains: { "line": int, "en": str, "cn": str }
    """
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return [], {}

    items = []
    meta = {}
    
    # Simple state machine to combine adjacent lines if they are part of same sentence pair
    # However, NCE-Flow format seems to be strictly line-based or piped |
    # Based on lesson.js logic:
    # 1. Pipeline format: EN text | CN text
    # 2. Adjacent lines: Line 1 is EN, Line 2 (same timestamp) is CN (rarely used in this repo based on structure)
    
    for i, line in enumerate(lines):
        line = line.strip()
        if not line:
            continue
            
        # Check metadata
        meta_match = META_RE.match(line)
        if meta_match:
            key, value = meta_match.groups()
            meta[key.lower()] = value.strip()
            continue
            
        # Check content
        # Remove all timestamps
        clean_line = TIME_RE.sub('', line).strip()
        if not clean_line:
            continue
            
        en = clean_line
        cn = ""
        
        if '|' in clean_line:
            parts = clean_line.split('|', 1)
            en = parts[0].strip()
            cn = parts[1].strip()
        
        # Add to items
        # We store index 'i' which corresponds to the array index in client-side 'items' array
        # Note: server-side parsing here might slightly differ from client-side if we are not careful
        # But for search, approximate line index is usually enough to jump to.
        # Actually client side lesson.js parses timestamps to build the list. 
        # So we should ideally just store text for searching.
        
        # To be safe and compatible with lesson.js 'items' array index, 
        # we need to emulate how lesson.js builds the items array.
        # lesson.js filters out metadata lines first? No, it loops all rows.
        # It handles pipeline | split.
        
        items.append({
            "en": en,
            "cn": cn
        })

    return items, meta

def generate_index():
    index = []
    
    for book in NCE_DIRS:
        print(f"Processing {book}...")
        # Search for all .lrc files
        # Structure is NCE1/1.lrc, NCE1/2.lrc etc.
        files = glob.glob(os.path.join(book, "*.lrc"))
        
        # Sort files numerically if possible (1.lrc, 2.lrc...)
        files.sort(key=lambda x: int(os.path.basename(x).split('.')[0]) if os.path.basename(x).split('.')[0].isdigit() else float('inf'))

        for lrc_file in files:
            # Get lesson ID from filename (e.g., '1' from 'NCE1/1.lrc')
            base_name = os.path.basename(lrc_file)
            lesson_id = os.path.splitext(base_name)[0]
            
            items, meta = parse_lrc(lrc_file)
            
            if not items:
                continue
                
            title = meta.get('ti', f'Lesson {lesson_id}')
            
            # Create a compressed searchable entry
            # We don't want to store full text if it makes the JSON too big?
            # actually for 4 books * 100 lessons * 20 lines, it's roughly 8000 lines.
            # 8000 lines * 100 chars = 800KB. It's totally fine to store full text.
            
            entry = {
                "b": book,      # Book ID (NCE1)
                "l": lesson_id, # Lesson ID (1)
                "t": title,     # Title
                "c": []         # Content
            }
            
            for idx, item in enumerate(items):
                # Optimize: only store if content exists
                if item['en'] or item['cn']:
                   # We store a simplified tuple to save space: [line_idx, en, cn]
                   entry['c'].append([idx, item['en'], item['cn']])
            
            index.append(entry)
            
    # Ensure static dir exists
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':')) # Minify
        
    print(f"Successfully generated index with {len(index)} lessons.")
    print(f"Output size: {os.path.getsize(OUTPUT_FILE) / 1024:.2f} KB")

if __name__ == '__main__':
    generate_index()

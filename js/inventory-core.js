
    // --- STATE MANAGEMENT ---
    let currentFilter = "ALL";
    let openFolders = new Set(); 
    let inventory = []; 

    // --- LOCAL DESKTOP FILE MODE ---
    // Browsers generally block reading an adjacent .json through file:// URLs.
    // The user opens it once with the file picker; on Chromium browsers the
    // File System Access API can write back to that exact selected file.
    // Other browsers can still read it and export a new inventory.json.
    let selectedJsonHandle = null;
    let selectedJsonName = '';
    let selectedDirectoryHandle = null;
    let savedDirectoryHandle = null;
    let hasInventoryFile = false;
    let changesUnsaved = false;
    let actionQueue = Promise.resolve();
    const INVENTORY_FOLDER_KEY = 'valeo-inventory-folder';
    const INVENTORY_DB_NAME = 'valeo-nexus-directory-handles-v1';
    // Statistics are stored separately: inventory.json remains a plain array.
    const ACTIVITY_FILE = 'inventory_activity.json';
    let inventoryActivity = [];
    let statsPanelOpen = false;
    let activityPersistError = '';
    let activitySource = 'session';


    /* FileSystemDirectoryHandle is a structured-cloneable object in IndexedDB.
       Remembering it does NOT bypass OS/browser permission prompts. */
    function openHandleDB() {
        return new Promise((resolve,reject) => {
            const req = indexedDB.open(INVENTORY_DB_NAME,1);
            req.onupgradeneeded = () => req.result.createObjectStore('handles');
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function saveRememberedFolder(handle) {
        const db = await openHandleDB();
        try {
            await new Promise((resolve,reject) => {
                const tx = db.transaction('handles','readwrite');
                tx.objectStore('handles').put(handle,INVENTORY_FOLDER_KEY);
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } finally { db.close(); }
    }
    async function loadRememberedFolder() {
        const db = await openHandleDB();
        try {
            return await new Promise((resolve,reject) => {
                const tx = db.transaction('handles','readonly');
                const r = tx.objectStore('handles').get(INVENTORY_FOLDER_KEY);
                r.onsuccess = () => resolve(r.result || null);
                r.onerror = () => reject(r.error);
            });
        } finally { db.close(); }
    }
    function setFolderButton(state, name='') {
        const btn = document.getElementById('folderSyncButton');
        if (!btn) return;
        btn.classList.toggle('is-connected',state==='connected');
        btn.classList.toggle('is-pending',state==='pending');
        btn.textContent = state==='connected' ? (name || 'VALEO_INVENTORY') :
                          state==='pending' ? 'RECONNECT FOLDER' : 'SYNC READY';
        btn.title = state==='connected' ? 'Connected to '+name+' • click to change folder' :
                    state==='pending' ? 'Reauthorize the remembered '+name+' folder' :
                    'Choose the VALEO_INVENTORY folder';
    }

    // STOCK UP MODE: barcode scans add 1 instead of subtracting 1.
    // Manual +/- buttons continue to do exactly what their icons say.
    const STOCK_UP_IDLE_MS = 10 * 60 * 1000;
    let stockUpMode = false;
    let stockUpActivityAt = 0;
    function stopStockUpMode(expired=false) {
        if (!stockUpMode) return;
        stockUpMode=false;
        document.body.classList.remove('stock-up-mode');
        renderStockUpButton();
        triggerStatus(expired ? 'STOCK UP EXPIRED • SCANS NOW SUBTRACT' : 'STOCK UP OFF • SCANS SUBTRACT', expired ? 'warning' : 'info');
    }
    function checkStockUpExpiry() {
        if (stockUpMode && Date.now()-stockUpActivityAt>=STOCK_UP_IDLE_MS) stopStockUpMode(true);
    }
    function markStockUpActivity() {
        if (!stockUpMode) return;
        checkStockUpExpiry();
        if (stockUpMode) stockUpActivityAt=Date.now();
    }
    function renderStockUpButton() {
        const btn=document.getElementById('stockModeButton');
        if (!btn) return;
        btn.classList.toggle('stock-up-active',stockUpMode);
        btn.setAttribute('aria-pressed',String(stockUpMode));
        if (!stockUpMode) {btn.textContent='STOCK UP: OFF';return;}
        const remaining=Math.max(0,STOCK_UP_IDLE_MS-(Date.now()-stockUpActivityAt));
        const secs=Math.ceil(remaining/1000);
        btn.textContent=`STOCK UP +1 • ${Math.floor(secs/60)}:${String(secs%60).padStart(2,'0')}`;
    }
    window.toggleStockUpMode=function() {
        // HID scanners type characters (including SPACE/ENTER). Never leave this button
        // focused: a scanner-generated space can otherwise click it a second time.
        if (document.activeElement === document.getElementById('stockModeButton')) {
            document.activeElement.blur();
        }
        checkStockUpExpiry();
        if (stockUpMode) {stopStockUpMode();return;}
        if (!hasInventoryFile) {triggerStatus('CONNECT INVENTORY BEFORE STOCK UP','warning');return;}
        stockUpMode=true;
        document.body.classList.add('stock-up-mode');
        stockUpActivityAt=Date.now();
        renderStockUpButton();
        triggerStatus('STOCK UP ON • SCANS NOW ADD +1','success');
    };
    for (const eventName of ['pointerdown','keydown','touchstart']) {
        document.addEventListener(eventName,markStockUpActivity,{passive:true});
    }
    window.addEventListener('focus',checkStockUpExpiry);
    document.addEventListener('visibilitychange',checkStockUpExpiry);
    setInterval(()=>{checkStockUpExpiry();renderStockUpButton();},1000);

    function setLocalFileStatus(message, state='') {
        const text = document.getElementById('offlineFileStatus');
        text.textContent = message;
        text.className = `screen-reader-only offline-status ${state}`;
        const saveBtn = document.getElementById('saveJsonButton');
        if (saveBtn) {
            saveBtn.disabled = !hasInventoryFile;
            // The save button is needed only for manual downloads / failed direct writes.
            saveBtn.hidden = !hasInventoryFile || (!!selectedJsonHandle && !changesUnsaved);
        }
    }

    function cloneInventory(data) {
        if (!Array.isArray(data)) throw new Error('inventory.json must contain a JSON array of items.');
        return data.map((raw, index) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Item ${index+1} is not a JSON object.`);
            const id = String(raw.id ?? '').trim().toUpperCase();
            const name = String(raw.name ?? '').trim();
            const qty = Number(raw.qty ?? 0);
            const threshold = Number(raw.threshold ?? 5);
            if (!id || !name || !Number.isInteger(qty) || qty < 0 || !Number.isInteger(threshold) || threshold < 0)
                throw new Error(`Invalid item at position ${index+1}: ID, name and nonnegative whole-number stock are required.`);
            return {
                ...raw,
                id, name, qty, threshold,
                group: String(raw.group ?? ''),
                category: String(raw.category ?? 'Uncategorized'),
                type: String(raw.type ?? 'Unit'),
                manufacturerBarcode: String(raw.manufacturerBarcode ?? ''),
                manufacturerBarcodes: Array.isArray(raw.manufacturerBarcodes) ? raw.manufacturerBarcodes.map(code => String(code)) : []
            };
        });
    }

    function codesForItem(item) {
        return [item.id, item.manufacturerBarcode,
            ...(Array.isArray(item.manufacturerBarcodes) ? item.manufacturerBarcodes : [])]
            .map(value => String(value ?? '').trim().toUpperCase()).filter(Boolean);
    }

    function validateUniqueCodes(items) {
        const seen = new Map();
        for (const item of items) {
            for (const code of codesForItem(item)) {
                if (seen.has(code)) {
                    throw new Error(`Barcode / Part ID "${code}" is duplicated on ${seen.get(code)} and ${item.id}.`);
                }
                seen.set(code,item.id);
            }
        }
    }

    function beginLocalInventory(data, label, handle) {
        const clean = cloneInventory(data);
        validateUniqueCodes(clean);
        inventory = clean;
        inventoryActivity = [];
        activitySource = 'session';
        activityPersistError = '';
        selectedJsonName = label;
        selectedJsonHandle = handle || null;
        hasInventoryFile = true;
        changesUnsaved = false;
        renderGrid();
        setFolderButton(handle && selectedDirectoryHandle ? 'connected' : 'ready',selectedDirectoryHandle?.name || label);
        setLocalFileStatus(`${label} • ${clean.length} item(s) loaded${handle ? ' • direct save available' : ' • export to save changes'}`, 'ready');
        triggerStatus(`LOCAL INVENTORY LOADED: ${clean.length} ITEMS`, 'success');
    }

    // One click binds the VALEO_INVENTORY directory. Store its handle for next launch.
    async function permissionForDirectory(handle,ask=false) {
        if (!handle) return false;
        try {
            let permission = typeof handle.queryPermission === 'function' ?
                await handle.queryPermission({mode:'readwrite'}) : 'prompt';
            if (permission!=='granted' && ask && typeof handle.requestPermission==='function') {
                permission = await handle.requestPermission({mode:'readwrite'});
            }
            return permission==='granted';
        } catch (error) { console.warn('Directory permission unavailable:',error); return false; }
    }
    async function loadInventoryFromFolder(directory) {
        let fileHandle;
        try { fileHandle = await directory.getFileHandle('inventory.json'); }
        catch (error) {
            if (error.name==='NotFoundError') throw new Error('inventory.json was not found inside '+directory.name+'.');
            throw error;
        }
        const file = await fileHandle.getFile();
        const data = JSON.parse(await file.text());
        const clean = cloneInventory(data);
        validateUniqueCodes(clean);
        selectedDirectoryHandle = directory;
        savedDirectoryHandle = directory;
        beginLocalInventory(clean,file.name,fileHandle);
        await readActivityFile(directory);
        setFolderButton('connected',directory.name);
        if (statsPanelOpen) renderStatistics();
        return true;
    }
    window.connectInventoryFolder = async function() {
        if (changesUnsaved && !confirm('Unsaved inventory changes would be lost. Switch folders anyway?')) return;
        const stored = savedDirectoryHandle;
        // A saved but unpermitted folder can be reauthorized on a real button click.
        if (stored && !selectedDirectoryHandle) {
            if (await permissionForDirectory(stored,true)) {
                try { await loadInventoryFromFolder(stored); return; }
                catch(error) { setLocalFileStatus(error.message,'pending'); triggerStatus('FOLDER ERROR: '+error.message,'critical'); return; }
            }
            setFolderButton('pending',stored.name);
            setLocalFileStatus('Permission required for '+stored.name+'; select another folder if needed.','pending');
            triggerStatus('FOLDER PERMISSION DENIED • SELECT FOLDER','warning');
            // Still permit choosing another folder after a remembered handle is denied.
        }
        if (typeof window.showDirectoryPicker === 'function') {
            try {
                const directory = await window.showDirectoryPicker({id:'valeo-inventory',mode:'readwrite'});
                await loadInventoryFromFolder(directory);
                try { await saveRememberedFolder(directory); }
                catch(error) { console.warn('Unable to remember selected folder:',error); triggerStatus('CONNECTED • BROWSER MAY NOT REMEMBER FOLDER','warning'); }
                return;
            } catch (error) {
                if(error.name==='AbortError') return;
                console.warn('Could not connect folder:',error);
                setLocalFileStatus(error.message,'pending');
                if (error.name==='SecurityError' || error.name==='NotAllowedError') {
                    triggerStatus('FOLDER ACCESS REQUIRES BROWSER PERMISSION','critical');
                } else { triggerStatus('FOLDER ERROR: '+error.message,'critical'); }
                return;
            }
        }
        // Older/mobile browsers: manual JSON selection is read-only until exported.
        const fallback = document.getElementById('offlineJsonInput');
        fallback.value=''; fallback.click();
    };
    window.openLocalInventory = window.connectInventoryFolder;

    window.chooseJsonFallback = async function(event) {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            selectedDirectoryHandle = null;
            beginLocalInventory(JSON.parse(await file.text()),file.name,null);
            setFolderButton('ready');
            triggerStatus('FILE-ONLY MODE • USE SAVE JSON TO KEEP CHANGES','warning');
        } catch (error) {
            alert(`Could not read ${file.name}: ${error.message}`);
            triggerStatus('INVALID INVENTORY JSON', 'critical');
        }
    };

    async function readActivityFile(directory) {
        let initializeEmpty = false;
        try {
            const handle = await directory.getFileHandle(ACTIVITY_FILE);
            const text = await (await handle.getFile()).text();
            // A 0-byte activity file is not valid JSON; a freshly created file
            // should be initialized as [] instead of permanently blocking writes.
            const data = text.trim() ? JSON.parse(text) : (initializeEmpty = true, []);
            if (!Array.isArray(data)) throw new Error('activity log must contain a JSON array');
            if (!data.every(e => e && typeof e === 'object' && typeof e.timestamp === 'string'))
                throw new Error('activity log has malformed events');
            inventoryActivity = data;
            activitySource = 'folder';
            activityPersistError = '';
        } catch (error) {
            if (error.name === 'NotFoundError') {
                inventoryActivity = [];
                activitySource = 'folder';
                activityPersistError = '';
                initializeEmpty = true;
            } else {
                // Preserve nonempty malformed history; never silently wipe it.
                inventoryActivity = [];
                activitySource = 'blocked';
                activityPersistError = 'Cannot read '+ACTIVITY_FILE+': '+error.message+'. Original file was NOT overwritten.';
                console.error(activityPersistError);
                triggerStatus('ACTIVITY FILE INVALID • CHECK JSON', 'critical');
                return;
            }
        }
        if (initializeEmpty && !(await persistActivity())) {
            triggerStatus('ACTIVITY HISTORY NOT WRITABLE', 'warning');
        }
    }

    async function persistActivity() {
        if (!selectedDirectoryHandle || activitySource === 'blocked') {
            activityPersistError = activitySource === 'blocked' ?
                (activityPersistError || 'Existing activity JSON is invalid; save blocked to protect it.') :
                'No writable inventory folder is connected; events are in memory only.';
            return false;
        }
        try {
            const fileHandle = await selectedDirectoryHandle.getFileHandle(ACTIVITY_FILE,{create:true});
            const writable = await fileHandle.createWritable();
            await writable.write(JSON.stringify(inventoryActivity,null,2)+'\n');
            await writable.close();
            activityPersistError = '';
            return true;
        } catch (error) {
            activityPersistError = 'Activity save failed: '+error.message;
            console.error(activityPersistError);
            return false;
        }
    }
    const shortStockName = name => {
        const limit = window.innerWidth < 730 ? 11 : window.innerWidth < 1150 ? 17 : 27;
        const value = String(name||'ITEM');
        return value.length > limit ? value.slice(0,limit-1)+'…' : value;
    };
    function formatStockStatus(result, saved=true) {
        const verb = result.delta > 0 ? '+1' : '−1';
        return `${verb} ${shortStockName(result.name)} | ${result.before} → ${result.qty}${saved?'':' • UNSAVED'}`;
    }
    function createActivityRecord(request,result,previousItem) {
        if (!['stock','scan','add','edit','delete'].includes(request.action)) return null;
        const afterItem = inventory.find(i=>i.id===result.itemId);
        const before = previousItem ? previousItem.qty : 0;
        const after = afterItem ? afterItem.qty : 0;
        let kind = request.action;
        if (request.action==='stock' || request.action==='scan') kind = after > before ? 'restock' : 'use';
        else if (request.action==='edit') kind = 'correction';
        else if (request.action==='add') kind = 'created';
        else if (request.action==='delete') kind = 'deleted';
        // Recorded as an audit event, but edits, creates and deletes do not count as usage/restocks.
        return {
            timestamp: new Date().toISOString(),
            kind, source:request.action==='scan'?'barcode':request.action==='stock'?'manual':request.action,
            itemId:result.itemId,previousItemId:result.previousItemId || undefined,
            name:result.name || previousItem?.name || '',
            category:afterItem?.category || previousItem?.category || 'Uncategorized',
            before, after, delta:after-before
        };
    }

    async function writeSelectedJson() {
        if (!selectedJsonHandle) return false;
        const contents = JSON.stringify(inventory,null,2)+'\n';
        try {
            const writable = await selectedJsonHandle.createWritable();
            await writable.write(contents);
            await writable.close();
            changesUnsaved = false;
            setLocalFileStatus(`${selectedJsonName} • ${inventory.length} item(s) • saved to original file`, 'ready');
            return true;
        } catch (error) {
            console.warn('Could not write to local JSON:',error);
            setLocalFileStatus('Changes not yet saved • use SAVE / DOWNLOAD JSON', 'pending');
            triggerStatus('LOCAL FILE WRITE BLOCKED • EXPORT JSON', 'critical');
            return false;
        }
    }

    window.saveLocalInventory = async function() {
        if (!hasInventoryFile) { alert('Open inventory.json first.'); return; }
        // Wait for queued updates before taking a snapshot to export.
        await actionQueue;
        if (await writeSelectedJson()) {
            triggerStatus('LOCAL JSON SAVED', 'success');
            return;
        }
        const blob = new Blob([JSON.stringify(inventory,null,2)+'\n'],{type:'application/json'});
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'inventory.json';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url),20000);
        // A download is a separate file, not a write to the source JSON.
        changesUnsaved = true; // downloaded a copy; the original selected JSON is still unchanged.
        setLocalFileStatus('inventory.json exported • original file NOT changed • replace it manually', 'pending');
        triggerStatus('JSON EXPORTED • REPLACE ORIGINAL FILE', 'info');
    };

    async function loadInventory() {
        setLocalFileStatus('Checking remembered VALEO_INVENTORY folder...');
        try {
            savedDirectoryHandle = await loadRememberedFolder();
            if (savedDirectoryHandle) {
                if (await permissionForDirectory(savedDirectoryHandle,false)) {
                    try { await loadInventoryFromFolder(savedDirectoryHandle); return; }
                    catch(error) { console.warn('Remembered inventory folder not readable:',error); }
                }
                setFolderButton('pending',savedDirectoryHandle.name);
                setLocalFileStatus('Folder remembered • click RECONNECT FOLDER to authorize access.', 'pending');
                return;
            }
        } catch (error) { console.warn('Remembering folder unavailable in this browser:',error); }
        // HTTP local-server preview can read an adjacent file, but not write it.
        // For editable inventory, select the actual VALEO_INVENTORY folder.
        setFolderButton('ready');
        setLocalFileStatus('Click SYNC READY to connect VALEO_INVENTORY/inventory.json.');
    }

    // An offline counterpart to /api/action; preserves barcode match semantics.
    // The local JSON file is never changed without browser file permission.
    function applyLocalAction(items, request) {
        const action = request.action;
        const findById = id => items.findIndex(item => item.id === String(id));
        if (action === 'stock') {
            if (![-1,1].includes(request.delta)) throw new Error('Invalid stock adjustment.');
            const idx = findById(request.id);
            if (idx < 0) throw new Error('Item not found.');
            const qty = items[idx].qty + request.delta;
            if (qty < 0) throw new Error('OUT OF STOCK — quantity cannot go below zero.');
            if (qty > 1000000) throw new Error('Stock exceeds the supported limit.');
            items[idx].qty = qty;
            return {ok:true,action,itemId:items[idx].id,name:items[idx].name,qty};
        }
        if (action === 'scan') {
            const code = String(request.code ?? '').trim().toUpperCase();
            if (!code || code.length > 180) throw new Error('Invalid barcode.');
            const matches = items.filter(item => codesForItem(item).includes(code));
            if (!matches.length) throw new Error(`UNKNOWN BARCODE: ${code}`);
            if (matches.length > 1) throw new Error('AMBIGUOUS BARCODE — check duplicate registrations.');
            const item = matches[0];
            const delta = request.delta === 1 ? 1 : -1;
            if (delta < 0 && item.qty < 1) throw new Error(`OUT OF STOCK: ${item.name}`);
            if (delta > 0 && item.qty >= 1000000) throw new Error('Stock exceeds the supported limit.');
            item.qty += delta;
            return {ok:true,action,itemId:item.id,name:item.name,qty:item.qty,delta};
        }
        if (action === 'delete') {
            const idx = findById(request.id);
            if (idx < 0) throw new Error('Item not found.');
            const item = items.splice(idx,1)[0];
            return {ok:true,action,itemId:item.id,name:item.name};
        }
        if (action === 'add' || action === 'edit') {
            const normalized = cloneInventory([request.item])[0];
            if (codesForItem(normalized).some(code => code.length > 180)) throw new Error('Barcode is too long.');
            if (normalized.manufacturerBarcodes.length > 8) throw new Error('Maximum eight additional barcodes.');
            if (new Set(codesForItem(normalized)).size !== codesForItem(normalized).length)
                throw new Error('Item contains duplicate barcode values.');
            const idx = findById(request.id);
            if (action === 'add') {
                if (items.some(item => item.id === normalized.id)) throw new Error('This Part ID already exists.');
                items.push(normalized);
            } else {
                if (idx < 0) throw new Error('Item to edit was not found.');
                // Allow renaming the internal Part ID while retaining the item's
                // stock, barcodes and metadata. Never overwrite a different item.
                if (normalized.id !== request.id && items.some((item,i) => i !== idx && item.id === normalized.id))
                    throw new Error('The new Part ID belongs to another item.');
                items[idx] = {...items[idx],...normalized};
            }
            validateUniqueCodes(items);
            return {ok:true,action,itemId:normalized.id,previousItemId:action==='edit'?request.id:null,name:normalized.name,qty:normalized.qty};
        }
        throw new Error(`Unsupported inventory action: ${action}`);
    }

    function sendAction(action, successMessage, kind='success') {
        const task = async () => {
            if (!hasInventoryFile) throw new Error('Open inventory.json first.');
            const previousItem = inventory.find(i => i.id === (action.id || '')) ||
                (action.action === 'scan' ? inventory.find(i => codesForItem(i).includes(String(action.code||'').trim().toUpperCase())) : null);
            const updated = inventory.map(item => ({...item,
                manufacturerBarcodes:[...(item.manufacturerBarcodes || [])]}));
            const result = applyLocalAction(updated,action);
            result.before = previousItem ? previousItem.qty : 0;
            result.delta = result.qty === undefined ? 0 : result.qty - result.before;
            inventory = updated;
            const eventRecord = createActivityRecord(action,result,previousItem);
            changesUnsaved = true;
            // Begin the visual exit before replacing the old table; persist in
            // parallel to avoid delaying the actual JSON save for decoration.
            const changedItem = inventory.find(i => i.id === result.itemId);
            const movement = animateItemHierarchy(previousItem,changedItem,result.itemId);
            const saved = await writeSelectedJson();
            let historySaved = true;
            if (eventRecord) {
                inventoryActivity.push(eventRecord);
                // Never pretend a log was written when the folder is inaccessible.
                if (saved) historySaved = await persistActivity();
                else historySaved = false;
            }
            const isMovement = action.action === 'scan' || action.action === 'stock';
            if (saved && historySaved) {
                triggerStatus(isMovement ? formatStockStatus(result,true) :
                    (typeof successMessage === 'function' ? successMessage(result) : successMessage),kind);
            } else if (saved) {
                triggerStatus(isMovement ? formatStockStatus(result,true)+' • HISTORY NOT SAVED' :
                    'STOCK SAVED • ACTIVITY HISTORY NOT SAVED','warning');
            } else {
                setLocalFileStatus(`UNSAVED changes • ${inventory.length} items • click SAVE / DOWNLOAD JSON`, 'pending');
                triggerStatus(isMovement ? formatStockStatus(result,false) : 'UPDATED IN MEMORY • EXPORT JSON TO KEEP','warning');
            }
            if (statsPanelOpen) renderStatistics();
            await movement;
            return result;
        };
        const run = actionQueue.then(task,task);
        actionQueue = run.catch(error => {
            console.error('Local inventory change rejected:',error);
            triggerStatus(`UPDATE FAILED: ${error.message}`,'critical');
        });
        return run;
    }

    window.addEventListener('beforeunload',event => {
        if (!changesUnsaved) return;
        event.preventDefault();
        event.returnValue = '';
    });

    // --- HID BARCODE / QR SCANNER ---
    // Scanners pair to the browser device and type a code plus Enter.
    // Only exact barcode matches update stock. Search NEVER modifies stock.
    let scanBuffer = '';
    let scanTimeout;
    let scanStartedAt = 0;
    let scanLastKeyAt = 0;
    let searchBeforeScanner = '';
    function scanCodeMatchesKnownItem(raw) {
        const code = String(raw).trim().toUpperCase();
        return code.length > 0 && inventory.some(item =>
            [item.id, item.manufacturerBarcode, ...(Array.isArray(item.manufacturerBarcodes) ? item.manufacturerBarcodes : [])]
                .some(value => String(value || '').trim().toUpperCase() === code));
    }
    window.addEventListener('keydown', (e) => {
        if (isLockedDown || e.ctrlKey || e.altKey || e.metaKey) return;
        if (e.key.length === 1 || ['Backspace','Enter','Delete','ArrowLeft','ArrowRight'].includes(e.key)) {
            hardwareKeyboardUsed = true;
            keyboardPreference = 'hidden';
            clearTimeout(autoKeyboardTimer);
            if (document.getElementById('inventoryWorkspace').classList.contains('keyboard-open')) {
                closeSearchKeyboard({preserveFocus:true, rememberChoice:false});
            }
        }
        const searchInput = document.getElementById('inventorySearch');
        const inSearch = e.target === searchInput;
        if (e.key === 'Escape' && inSearch) {
            closeSearchKeyboard();
            searchInput.blur();
            return;
        }
        // While Add/Edit is open, scanner keystrokes may populate its focused
        // barcode input, but must NEVER deduct inventory.
        if (document.getElementById('forgeModal').classList.contains('active')) return;
        if (!inSearch && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
        // Long industrial QR payloads often contain SPACE (e.g. Buehler grit papers).
        // A focused button treats that key as an activation, which could switch OFF
        // Stock Up and cause the scan to subtract. Release button focus immediately
        // and stop the browser's implicit Space/Enter button activation on a scan.
        if (!inSearch && e.target instanceof HTMLElement &&
                e.target.closest('button, [role="button"]') &&
                (e.key.length === 1 || (e.key === 'Enter' && scanBuffer))) {
            if (e.key === ' ' || e.key === 'Enter') e.preventDefault();
            e.target.blur();
        }
        const now = performance.now();
        if (e.key === 'Enter') {
            const code = scanBuffer.trim(); // Preserve UPC leading zeros and raw QR content.
            const fastScanner = code.length >= 4 &&
                (now - scanStartedAt) <= (code.length + 1) * 48;
            // Only recognize rapid *known* scans while the user is editing Search.
            // This prevents accidental deductions when someone types a search query.
            if (inSearch && fastScanner && scanCodeMatchesKnownItem(code)) {
                e.preventDefault();
                searchInput.value = searchBeforeScanner;
                onSearchInput();
                processScan(code);
            } else if (!inSearch && code) {
                e.preventDefault();
                processScan(code);
            }
            scanBuffer = '';
            clearTimeout(scanTimeout);
        } else if (e.key.length === 1) {
            if (!scanBuffer || now - scanLastKeyAt > 120) {
                scanBuffer = '';
                scanStartedAt = now;
                if (inSearch) searchBeforeScanner = searchInput.value;
            }
            scanBuffer += e.key;
            scanLastKeyAt = now;
            clearTimeout(scanTimeout);
            scanTimeout = setTimeout(() => { scanBuffer = ''; }, 160);
        }
    });

    function processScan(rawCode) {
        const code = String(rawCode).trim();
        if (!code) return;
        if (code.length > 180) {
            triggerStatus('BARCODE ERROR: MAX 180 CHARACTERS', 'critical');
            return;
        }
        checkStockUpExpiry();
        const delta = stockUpMode ? 1 : -1;
        if (stockUpMode) markStockUpActivity();
        sendAction({action: 'scan', code, delta}, response =>
            `SCAN ${response.delta>0?'+1':'-1'}: ${response.name} / ${response.itemId} | STOCK ${response.qty}`
        ).catch(() => {});
    }

    // --- ALIEN ORGANISM CANVAS LOGIC ---
    const canvas = document.getElementById('alienCanvas');
    const ctx = canvas.getContext('2d', { alpha: true });
    let particlesArray = []; 
    const MAX_PARTICLES = 90;

    function initCanvas() { 
        if(!canvas) return; 
        canvas.width = window.innerWidth; 
        canvas.height = window.innerHeight; 
        initParticles(); 
    }
    window.addEventListener('resize', initCanvas); 

    class Particle {
        constructor() {
            this.x = Math.random() * canvas.width; 
            this.y = Math.random() * canvas.height; 
            this.size = Math.random() * 2.5 + 1.2; 
            this.speedX = Math.random() * 0.4 - 0.2; 
            this.speedY = Math.random() * -0.8 - 0.2; 
            const colors = ['rgba(255, 59, 48,', 'rgba(157, 0, 255,', 'rgba(0, 243, 255,']; 
            this.colorBase = colors[Math.floor(Math.random() * colors.length)]; 
            
            this.opacity = Math.random() * 0.5 + 0.35;
            this.wiggleOffset = Math.random() * Math.PI * 2;
            this.wiggleSpeed = Math.random() * 0.015 + 0.005;
            this.wiggleMagnitude = Math.random() * 1.5 + 0.5;
        }
        update(time) { 
            let wiggle = Math.sin(time * this.wiggleSpeed + this.wiggleOffset) * this.wiggleMagnitude;
            this.x += this.speedX + wiggle; 
            this.y += this.speedY; 
            
            if (this.y < 0) { this.y = canvas.height; this.x = Math.random() * canvas.width; } 
            if (this.x < 0 || this.x > canvas.width) this.speedX = -this.speedX; 
        }
        draw() { 
            ctx.fillStyle = `${this.colorBase} ${this.opacity})`; 
            ctx.shadowBlur = 10; 
            ctx.shadowColor = `${this.colorBase} 1)`;
            ctx.beginPath(); 
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2); 
            ctx.fill(); 
            ctx.shadowBlur = 0; 
        }
    }

    function initParticles() { 
        particlesArray = []; 
        const numberOfParticles = Math.min(Math.floor((canvas.width * canvas.height) / 7000), MAX_PARTICLES); 
        for (let i = 0; i < numberOfParticles; i++) particlesArray.push(new Particle()); 
    }

    let lastTime = 0; 
    function animateParticles(time) { 
        requestAnimationFrame(animateParticles);
        if(!canvas || !ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height); 
        for (let i = 0; i < particlesArray.length; i++) { 
            particlesArray[i].update(time * 0.05); 
            particlesArray[i].draw(); 
        } 
    }
    
    initCanvas(); 
    requestAnimationFrame(animateParticles);

    // --- BEEPER STATUS BAR LOGIC ---
    let statusTimer;
    function triggerStatus(message, type = "info") {
        const bar = document.getElementById('sysStatus');
        const panel = document.getElementById('statusPanel');
        
        let color = "#39ff14"; 
        if (type === "success") color = "var(--mint)";
        if (type === "warning" || type === "critical") color = "var(--crimson)";
        if (type === "info") color = "var(--cyan)";

        bar.innerText = message;
        bar.style.color = color;
        bar.style.textShadow = `0 0 8px ${color}, 0 0 20px ${color}`;
        
        panel.style.boxShadow = `inset 0 0 35px ${color}, inset 0 0 10px #000`;

        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => {
            bar.innerText = "VALEO / LAB INVENTORY";
            bar.style.color = "#39ff14";
            bar.style.textShadow = "0 0 8px #39ff14, 0 0 15px #39ff14";
            panel.style.boxShadow = "inset 0 0 25px rgba(57, 255, 20, 0.25), inset 0 0 10px #000";
        }, 5500);
    }

    setInterval(() => {
        const criticalItems = inventory.filter(i => i.qty <= i.threshold);
        if (criticalItems.length > 0) {
            triggerStatus(`[ WARN ] ${criticalItems.length} ITEM(S) CRITICAL`, "critical");
        }
    }, 15000);

    // --- CIPHER & HACK EFFECT ---
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*<>";
    function runCipher(btn, selector, durationMs = -1) {
        let iterations = 0; 
        const targetText = btn.dataset.cipher; 
        const textElement = btn.querySelector(selector);
        if(!textElement) return;
        
        clearInterval(btn.dataset.interval);
        
        btn.dataset.interval = setInterval(() => {
            textElement.innerText = targetText.split("").map((letter, index) => {
                if(index < iterations) return targetText[index]; 
                return letters[Math.floor(Math.random() * letters.length)];
            }).join("");
            
            if(iterations >= targetText.length) {
                clearInterval(btn.dataset.interval);
            }
            iterations += durationMs > 0 ? 0.05 : 0.5;
        }, 30);
        
        if (durationMs > 0) {
            setTimeout(() => {
                clearInterval(btn.dataset.interval);
                textElement.innerText = targetText; 
            }, durationMs);
        }
    }

    document.querySelectorAll('.cipher-btn').forEach(btn => {
        btn.addEventListener('mouseenter', () => runCipher(btn, '.btn-title'));
    });

    setInterval(() => {
        triggerStatus("SYS_WARNING: ROGUE UPLINK DETECTED", "critical");
        document.querySelectorAll('.category-nav .menu-btn').forEach(btn => {
            btn.classList.add('hacked-glitch');
            runCipher(btn, '.btn-title', 5000);
        });
        setTimeout(() => {
            document.querySelectorAll('.category-nav .menu-btn').forEach(btn => {
                btn.classList.remove('hacked-glitch');
            });
        }, 5000);
    }, 300000);

    // --- ANTI-SPAM CORE MELTDOWN PROTOCOL ---
    let rapidClickCount = 0;
    let lastClickTime = 0;
    let isLockedDown = false;
    let lockdownTimerInterval;

    function triggerLockdown() {
        if (isLockedDown) return;
        isLockedDown = true;
        
        document.body.classList.add('lockdown-active');
        
        document.querySelectorAll('.btn-mini').forEach(btn => {
            const randomX = (Math.random() - 0.5) * 600;
            const randomY = (Math.random() - 0.5) * 600;
            const randomRot = (Math.random() - 0.5) * 180;
            btn.style.setProperty('transform', `translate(${randomX}px, ${randomY}px) rotate(${randomRot}deg)`, 'important');
        });

        const overlay = document.getElementById('lockdownScreen');
        overlay.style.display = 'flex';
        overlay.classList.remove('cooldown-mode');
        
        document.getElementById('lockTitle').innerText = "SECURITY VIOLATION";
        document.getElementById('lockSub').innerText = "TAMPERING DETECTED";
        
        document.getElementById('dispatchMsg').innerHTML = `
            <span class="blink-red">> UPLINK SECURED: FACILITY SECURITY NOTIFIED.</span>
            <span>> ARMED RESPONSE TEAM EN ROUTE...</span>
            <span>> DO NOT ATTEMPT TO LEAVE THE TERMINAL.</span>
            <span style="color:var(--cyan);">> PLEASE REMAIN IN DIRECT SIGHT OF OVERHEAD BIOMETRIC CAMERAS.</span>
        `;
        
        let timeLeft = 300; 
        
        lockdownTimerInterval = setInterval(() => {
            timeLeft--;
            const m = Math.floor(timeLeft / 60).toString().padStart(2, '0');
            const s = (timeLeft % 60).toString().padStart(2, '0');
            document.getElementById('lockTimer').innerText = `${m}:${s}`;
            
            if (timeLeft === 60) {
                overlay.classList.add('cooldown-mode');
                document.getElementById('lockTitle').innerText = "SYSTEM COOLING DOWN";
                document.getElementById('lockSub').innerText = "RESTORE IMMINENT";
                
                document.getElementById('dispatchMsg').innerHTML = `
                    <span style="color:var(--gold); font-weight:bold;">> SECURITY DISPATCH CANCELLED.</span>
                    <span>> FALSE ALARM LOGGED IN SYSTEM CORE.</span>
                    <span>> PLEASE WAIT FOR TERMINAL REBOOT.</span>
                `;
                
                document.body.classList.remove('lockdown-active');
                
                document.querySelectorAll('.btn-mini').forEach(btn => {
                    btn.style.cssText = ''; 
                });
            }
            
            if (timeLeft <= 0) {
                clearInterval(lockdownTimerInterval);
                overlay.style.display = 'none';
                isLockedDown = false;
                rapidClickCount = 0;
                
                document.getElementById('dispatchMsg').innerHTML = `
                    <span class="blink-red">> UPLINK SECURED: FACILITY SECURITY NOTIFIED.</span>
                    <span>> ARMED RESPONSE TEAM EN ROUTE...</span>
                    <span>> DO NOT ATTEMPT TO LEAVE THE TERMINAL.</span>
                    <span style="color:var(--cyan);">> PLEASE REMAIN IN DIRECT SIGHT OF OVERHEAD BIOMETRIC CAMERAS.</span>
                `;
                
                renderGrid();
            }
        }, 1000);
    }

    // --- ACCORDION FOLDER STATE CONTROL ---
    window.toggleGroup = function(groupId) {
        const isOpening = !openFolders.has(groupId);
        if (isOpening) {
            openFolders.add(groupId);
        } else {
            openFolders.delete(groupId);
        }
        renderGrid(); 
    };

    // --- RENDERING LOGIC ---
    function getCategoryColorInfo(categoryName) {
        let catColor = "var(--text-muted)";
        let catTextShadow = "none";
        const upperCat = (categoryName || "").toUpperCase();
        if (upperCat === "DSC") { catColor = "var(--crimson)"; catTextShadow = "0 0 8px var(--crimson)"; }
        else if (upperCat === "X-SECTION") { catColor = "var(--violet)"; catTextShadow = "0 0 8px var(--violet)"; }
        else if (upperCat === "QUALITY") { catColor = "var(--cyan)"; catTextShadow = "0 0 8px var(--cyan)"; }
        else if (upperCat === "CLEAN-UP") { catColor = "var(--mint)"; catTextShadow = "0 0 8px var(--mint)"; }
        return { catColor, catTextShadow };
    }

    function setCategoryFilter(category) {
        currentFilter = category;
        triggerStatus(`FILTER > ${category}`, "info");
        
        document.querySelectorAll('.category-nav .menu-btn').forEach(btn => {
            btn.classList.remove('active-cat');
            if (btn.innerText.includes(category.toUpperCase())) btn.classList.add('active-cat');
            if (category === 'ALL' && btn.classList.contains('btn-all')) btn.classList.add('active-cat');
        });
        
        renderGrid();
    }

    // Escape user-defined names and IDs before inserting them into table HTML.
    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[ch]);
    }

    // --- FUZZY, NUMBER-AWARE INVENTORY SEARCH ---
    // Convert basic number words to digits: one-thousand -> 1thousand.
    // Also index "1000" for one-thousand. This supports 1thousa, 1000, etc.
    const numberWords = Object.freeze({zero:'0',one:'1',two:'2',three:'3',four:'4',five:'5',six:'6',seven:'7',eight:'8',nine:'9',ten:'10'});
    function compactSearch(value) {
        return String(value ?? '').toLowerCase().normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '').replace(/[µμ]/g,'u')
            .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten)\b/g,
                word => numberWords[word])
            .replace(/[^a-z0-9]/g,'');
    }
    function searchVariants(value) {
        const raw = String(value ?? '');
        const variants = new Set([compactSearch(raw)]);
        // Natural numeric variant, e.g. "one-thousand" -> "1000".
        const numeric = raw.replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten|[1-9])[-\s_]*thousand\b/gi,
            (_, number) => `${Number(numberWords[number.toLowerCase()] || number) * 1000}`);
        variants.add(compactSearch(numeric));
        raw.split(/[\s\-_/()]+/).forEach(part => variants.add(compactSearch(part)));
        return [...variants].filter(Boolean);
    }
    function editDistanceWithin(a, b, limit) {
        // Bounded, transposition-aware edit distance.  'bottel' matches 'bottle',
        // 'grti' matches 'grit', while exact identifiers still rank first.
        if (Math.abs(a.length-b.length)>limit) return limit+1;
        let prevPrev=null;
        let prev=Array.from({length:b.length+1},(_,i)=>i);
        for(let i=1;i<=a.length;i++) {
            const row=[i];
            for(let j=1;j<=b.length;j++) {
                let cost=(a[i-1]===b[j-1])?0:1;
                let distance=Math.min(prev[j]+1,row[j-1]+1,prev[j-1]+cost);
                if(prevPrev && i>1 && j>1 && a[i-1]===b[j-2] && a[i-2]===b[j-1]) {
                    distance=Math.min(distance,prevPrev[j-2]+1);
                }
                row[j]=distance;
            }
            prevPrev=prev;
            prev=row;
        }
        return prev[b.length];
    }
    function scoreTerm(query, value) {
        if (!query || !value) return 0;
        if (query === value) return 120;
        if (value.startsWith(query)) return 110;
        if (value.includes(query)) return 96;
        if (query.length < 4) return 0; // Avoid noisy typo matches for short searches.
        const tolerance = query.length >= 10 ? 3 : query.length >= 6 ? 2 : 1;
        const minLen = Math.max(1, query.length - tolerance);
        const maxLen = Math.min(value.length, query.length + tolerance);
        let best = 0;
        // Try the start of each word/normalized field, plus partial substrings.
        // Search database is capped at 500 items by the ESP32 firmware.
        for (let i = 0; i < value.length; i++) {
            if (value.length - i < minLen) break;
            for (let length = minLen; length <= maxLen && i + length <= value.length; length++) {
                const distance = editDistanceWithin(query,value.slice(i,i+length),tolerance);
                if (distance <= tolerance) best = Math.max(best, 80 - 16 * distance);
            }
            if (best >= 64) break;
        }
        return best;
    }
    function smartSearchScore(item, text) {
        const terms = String(text).trim().split(/\s+/).map(compactSearch).filter(Boolean);
        if (!terms.length) return 1;
        const variants = [item.id,item.name,item.category,item.type,item.group,
            item.manufacturerBarcode,...(Array.isArray(item.manufacturerBarcodes) ? item.manufacturerBarcodes : [])]
            .flatMap(searchVariants);
        let total = 0;
        for (const term of terms) {
            let best = 0;
            for (const variant of variants) best = Math.max(best,scoreTerm(term,variant));
            if (!best) return 0; // All terms must match some inventory field.
            total += best;
        }
        return total / terms.length;
    }
    function visibleItems() {
        const query = document.getElementById('inventorySearch').value.trim();
        return inventory.filter(item => currentFilter === 'ALL' || item.category === currentFilter)
            .map(item => ({item,score:smartSearchScore(item,query)}))
            .filter(result => result.score > 0)
            .sort((a,b) => query ? b.score - a.score || a.item.qty - b.item.qty : a.item.qty - b.item.qty)
            .map(result => result.item);
    }

    // --- OPTIONAL ON-SCREEN KEYBOARD + TOUCH-FRIENDLY STOCK CARDS ---
    // Browsers do not offer a dependable way to detect a connected physical keyboard.
    // Prioritize ordinary typing; use a conservative touch/viewport heuristic on desktop
    // touchscreens, plus an always-visible manual keyboard toggle at the right of Search.
    let hardwareKeyboardUsed = false;
    let keyboardPreference = 'auto'; // 'auto', 'touch' (manually shown), or 'hidden'
    let autoKeyboardTimer = null;
    function nativeKeyboardVisible(beforeHeight) {
        const visibleHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        const nativeRect = navigator.virtualKeyboard?.boundingRect;
        return (beforeHeight - visibleHeight > 110) || (nativeRect && nativeRect.height > 110);
    }
    function rememberSearchPointer(event) {
        clearTimeout(autoKeyboardTimer);
        // Mouse and keyboard users get the normal text field; nothing pops out.
        if (!['touch', 'pen'].includes(event.pointerType)) return;
        // Phones/tablets normally have their own system keyboard. Let the OS provide it.
        const usesNativeTouchKeyboard = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        if (usesNativeTouchKeyboard || hardwareKeyboardUsed || keyboardPreference !== 'auto') return;
        const startHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
        autoKeyboardTimer = setTimeout(() => {
            const input = document.getElementById('inventorySearch');
            if (document.activeElement !== input || hardwareKeyboardUsed || keyboardPreference !== 'auto') return;
            if (!nativeKeyboardVisible(startHeight)) openSearchKeyboard(true);
        }, 350);
    }
    function openSearchKeyboard(automatic = false) {
        clearTimeout(autoKeyboardTimer);
        if (!automatic) keyboardPreference = 'touch';
        const input = document.getElementById('inventorySearch');
        // Suppress a second OS keyboard while the custom right-hand keyboard is in use.
        input.inputMode = 'none';
        document.getElementById('inventoryWorkspace').classList.add('keyboard-open');
        const toggle = document.getElementById('searchKeyboardToggle');
        toggle.setAttribute('aria-pressed', 'true');
        toggle.setAttribute('aria-label', 'Hide on-screen keyboard');
        input.setAttribute('aria-expanded','true');
        input.blur();
        input.focus({preventScroll:true});
        renderGrid();
    }
    function closeSearchKeyboard({preserveFocus = false, rememberChoice = true} = {}) {
        clearTimeout(autoKeyboardTimer);
        if (rememberChoice) keyboardPreference = 'hidden';
        document.getElementById('inventoryWorkspace').classList.remove('keyboard-open');
        const input = document.getElementById('inventorySearch');
        input.inputMode = 'search';
        input.setAttribute('aria-expanded','false');
        const toggle = document.getElementById('searchKeyboardToggle');
        toggle.setAttribute('aria-pressed', 'false');
        toggle.setAttribute('aria-label', 'Show on-screen keyboard');
        if (!preserveFocus) input.blur();
        renderGrid();
    }
    function toggleSearchKeyboard() {
        if (document.getElementById('inventoryWorkspace').classList.contains('keyboard-open')) {
            closeSearchKeyboard();
        } else {
            openSearchKeyboard();
        }
    }
    function onSearchInput() { renderGrid(); }
    function virtualKeyPress(key) {
        const input = document.getElementById('inventorySearch');
        let start = input.selectionStart ?? input.value.length;
        let end = input.selectionEnd ?? input.value.length;
        if (key === 'CLEAR') {
            input.value = '';
            start = 0;
        } else if (key === 'BACKSPACE') {
            if (start === end && start > 0) start--;
            input.setRangeText('',start,end,'start');
        } else {
            input.setRangeText(key === 'SPACE' ? ' ' : key.toLowerCase(),start,end,'end');
        }
        scanBuffer = '';
        // inputmode=none asks mobile devices not to raise their native keyboard.
        input.focus({preventScroll:true});
        input.setSelectionRange(key === 'CLEAR' ? 0 : input.selectionStart,
                                key === 'CLEAR' ? 0 : input.selectionEnd);
        onSearchInput();
    }
    function buildTouchKeyboard() {
        const rows = ['1234567890','QWERTYUIOP','ASDFGHJKL','ZXCVBNM'];
        const element = document.getElementById('keyboardKeys');
        const keyButton = (character, cls = '') => `<button type="button" class="keyboard-key ${cls}" data-key="${character}" aria-label="${character}">${character}</button>`;
        element.innerHTML = rows.map(row => `<div class="keyboard-row">${[...row].map(key => keyButton(key)).join('')}</div>`).join('') +
            '<div class="keyboard-row">' + keyButton('-') + keyButton('SPACE','space special').replace('>SPACE<','>SPACE<') + keyButton('BACKSPACE','wide special').replace('>BACKSPACE<','>⌫<') + '</div>' +
            '<div class="keyboard-row">' + keyButton('CLEAR','wide clear').replace('>CLEAR<','>CLEAR SEARCH<') + '</div>';
        element.addEventListener('pointerdown', e => {
            // Keep the caret in Search when tapping virtual keys.
            if (e.target.closest('[data-key]')) e.preventDefault();
        });
        element.addEventListener('click', e => {
            const button = e.target.closest('[data-key]');
            if (button) virtualKeyPress(button.dataset.key);
        });
    }
    function renderQuickResults(items, query) {
        const count = document.getElementById('quickResultCount');
        const host = document.getElementById('quickResultList');
        count.textContent = `${items.length} MATCH${items.length === 1 ? '' : 'ES'}`;
        const shown = items.slice(0,100);
        if (!shown.length) {
            host.innerHTML = `<div class="quick-empty">NO MATCHES FOR <strong>${escapeHtml(query)}</strong><br>Try fewer letters, a part ID, or another spelling.</div>`;
            return;
        }
        host.innerHTML = shown.map(item => {
            const critical = item.qty <= item.threshold;
            const label = critical ? 'CRITICAL' : 'IN STOCK';
            return `<article class="quick-card ${critical ? 'is-critical' : ''}" data-inventory-item="${escapeHtml(item.id)}">
                <div class="quick-info">
                    <div class="quick-name">${escapeHtml(item.name)}</div>
                    <div class="quick-id">PART ID: ${escapeHtml(item.id)}</div>
                    <div class="quick-meta">
                        <span>${escapeHtml(item.category || 'Uncategorized')}</span>
                        <span>${escapeHtml(item.type || 'Unit')}</span>
                        ${item.group ? `<span>Folder: ${escapeHtml(item.group)}</span>` : ''}
                        ${item.manufacturerBarcode ? `<span class="barcode-value" title="${escapeHtml(item.manufacturerBarcode)}">BARCODE: ${escapeHtml(item.manufacturerBarcode)}</span>` : ''}
                        ${Array.isArray(item.manufacturerBarcodes) && item.manufacturerBarcodes.length ? `<span>${item.manufacturerBarcodes.length} alternate label(s)</span>` : ''}
                        <span style="color:${critical ? 'var(--crimson)' : 'var(--mint)'}">${label}</span>
                    </div>
                </div>
                <div class="quick-controls">
                    <div class="quick-qty"><strong>${Number(item.qty)}</strong><small>UNITS</small></div>
                    <div class="quick-adjust">
                        <button class="btn-mini sub" data-action="sub" data-id="${escapeHtml(item.id)}" ${item.qty <= 0 ? 'disabled' : ''} aria-label="Remove one ${escapeHtml(item.name)}">−</button>
                        <button class="btn-mini add" data-action="add" data-id="${escapeHtml(item.id)}" aria-label="Add one ${escapeHtml(item.name)}">+</button>
                    </div>
                    <div class="quick-tools"><button class="btn-mini edit" data-action="edit" data-id="${escapeHtml(item.id)}">EDIT</button></div>
                </div>
            </article>`;
        }).join('') + (items.length > 100 ? `<div class="quick-empty">Showing first 100 of ${items.length} results. Type more to narrow down.</div>` : '');
    }
    buildTouchKeyboard();

    function renderRowHtml(item, isChild = false, parentId = "") {
        const isCritical = item.qty <= item.threshold;
        const statusClass = isCritical ? 'status-critical' : 'status-nominal';
        const statusText = isCritical ? 'CRITICAL' : 'NOMINAL';
        const statusColor = isCritical ? 'var(--crimson)' : 'var(--mint)';
        const { catColor, catTextShadow } = getCategoryColorInfo(item.category);
        const searching = !!document.getElementById('inventorySearch').value.trim();
        const childClass = isChild ? 'group-child' : '';
        const childStyle = isChild && !searching && !openFolders.has(parentId) ? 'style="display: none;"' : '';
        const idPrefix = isChild ? '<span class="tree-branch">└─ </span>' : '';
        return `
            <tr class="${statusClass} ${childClass}" data-inventory-item="${escapeHtml(item.id)}" ${childStyle}>
                <td class="cell-id">${idPrefix}${escapeHtml(item.id)}</td>
                <td class="cell-category" style="color:${catColor}; text-shadow:${catTextShadow}; font-weight:bold;">${escapeHtml((item.category || '').toUpperCase())}</td>
                <td><div class="cell-name">${escapeHtml(item.name)}</div>${item.manufacturerBarcode ? `<small class="barcode-value" title="${escapeHtml(item.manufacturerBarcode)}">BARCODE: ${escapeHtml(item.manufacturerBarcode)}</small>` : ''}</td>
                <td class="cell-qty">${item.qty}</td>
                <td class="cell-type">[ ${escapeHtml(item.type ? item.type.toUpperCase() : 'UNIT')} ]</td>
                <td><span class="cell-badge" style="color:${statusColor}; border-color:${statusColor};">${statusText}</span></td>
                <td>
                    <div class="action-group">
                        <button class="btn-mini sub" data-action="sub" data-id="${escapeHtml(item.id)}">−</button>
                        <button class="btn-mini add" data-action="add" data-id="${escapeHtml(item.id)}">+</button>
                        <button class="btn-mini edit" data-action="edit" data-id="${escapeHtml(item.id)}">EDIT</button>
                        <button class="btn-mini del" data-action="delete" data-id="${escapeHtml(item.id)}">DEL</button>
                    </div>
                </td>
            </tr>
        `;
    }

    function renderGrid() {
        if (isLockedDown) return;
        const query = document.getElementById('inventorySearch').value.trim();
        document.getElementById('inventoryWorkspace').classList.toggle('search-results-active', !!query);
        const results = visibleItems();
        // The same filtered results drive both normal table and large-button touch cards.
        renderQuickResults(results,query);
        const tbodyNormal = document.getElementById('inventoryGridBody');
        const tbodyCritical = document.getElementById('criticalGridBody');
        const criticalSection = document.getElementById('criticalSection');
        let normalHtml = '';
        let criticalHtml = '';
        const normalGroups = Object.create(null);
        const standaloneNormal = [];
        results.forEach(item => {
            if (item.qty <= item.threshold) {
                criticalHtml += renderRowHtml(item);
            } else if (item.group) {
                (normalGroups[item.group] ||= []).push(item);
            } else {
                standaloneNormal.push(item);
            }
        });
        const sortedFolders = Object.entries(normalGroups).map(([groupName, items]) => ({
            groupName,items,totalQty:items.reduce((sum,item) => sum + item.qty,0)
        })).sort((a,b) => a.totalQty - b.totalQty);
        sortedFolders.forEach(folder => {
            const headerId = encodeURIComponent(folder.groupName);
            const isOpen = !!query || openFolders.has(headerId);
            const iconText = isOpen ? '−' : '+';
            normalHtml += `<tr class="group-header status-nominal" style="cursor:pointer" data-folder-id="${escapeHtml(headerId)}" aria-expanded="${isOpen}">
                <td colspan="7">
                    <span class="folder-icon" aria-hidden="true">${iconText}</span><span class="folder-label">${escapeHtml(folder.groupName.toUpperCase())} FOLDER</span>
                </td>
            </tr>`;
            folder.items.forEach(item => normalHtml += renderRowHtml(item,true,headerId));
        });
        standaloneNormal.forEach(item => normalHtml += renderRowHtml(item));
        tbodyNormal.innerHTML = normalHtml || (!criticalHtml && query ? '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">NO MATCHING ITEMS</td></tr>' : '');
        tbodyCritical.innerHTML = criticalHtml;
        criticalSection.style.display = criticalHtml ? 'block' : 'none';
    }

    // Critical/normal transitions keep the left-exit/left-entry effect.
    // Reorders WITHIN a table glide OVER the other rows using FLIP geometry.
    const hierarchyFor = item => !item ? 'absent' :
        (item.qty <= item.threshold ? 'critical' : item.group ? 'folder:' + item.group : 'normal');
    function itemNodesById(id) {
        return Array.from(document.querySelectorAll('[data-inventory-item]'))
            .filter(node => node.dataset.inventoryItem === String(id));
    }
    function visibleMotionNodes(id) {
        return itemNodesById(id).filter(node => {
            const rect = node.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 &&
                getComputedStyle(node).display !== 'none' &&
                getComputedStyle(node).visibility !== 'hidden';
        });
    }
    function inventoryMotionKey(node) {
        if (node.dataset.folderId !== undefined) return 'folder:'+node.dataset.folderId;
        if (node.classList.contains('quick-card')) return 'quick:'+node.dataset.inventoryItem;
        const tbody = node.closest('tbody');
        return tbody ? tbody.id+':'+node.dataset.inventoryItem : '';
    }
    function visibleInventoryRows() {
        return Array.from(document.querySelectorAll(
            '#inventoryGridBody tr[data-inventory-item],#criticalGridBody tr[data-inventory-item],'+
            '#inventoryGridBody tr[data-folder-id],#quickResultList .quick-card[data-inventory-item]'
        )).filter(node => node.getClientRects().length && node.getBoundingClientRect().height>0);
    }
    function glideItemWithinTable(changedId) {
        const before = new Map();
        for(const node of visibleInventoryRows()) {
            const r = node.getBoundingClientRect();
            before.set(inventoryMotionKey(node),{top:r.top,left:r.left});
        }
        renderGrid();
        if (typeof Element.prototype.animate !== 'function') return;
        for(const node of visibleInventoryRows()) {
            const first = before.get(inventoryMotionKey(node));
            if (!first) continue;
            const r=node.getBoundingClientRect();
            const dx=first.left-r.left, dy=first.top-r.top;
            if (Math.abs(dx)<2 && Math.abs(dy)<2) continue;
            // Don't animate rows that are completely outside the visible view.
            if ((r.bottom < -120 || r.top > innerHeight+120) &&
                (first.top < -120 || first.top > innerHeight+120)) continue;
            const selected=node.dataset.inventoryItem===String(changedId);
            if(selected) node.classList.add('inventory-row-overlap');
            const movement=node.animate([
                {transform:`translate3d(${dx}px,${dy}px,0)`},
                {transform:'translate3d(0,0,0)'}
            ],{duration:selected?680:580,easing:'cubic-bezier(.18,.8,.25,1)'});
            movement.finished.then(()=>node.classList.remove('inventory-row-overlap'))
                .catch(()=>node.classList.remove('inventory-row-overlap'));
        }
    }
    async function animateItemHierarchy(before, after, id) {
        const changed = before && after && hierarchyFor(before) !== hierarchyFor(after);
        const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!changed) {
            if (reduced) renderGrid();
            else glideItemWithinTable(id);
            return;
        }
        if (reduced) {renderGrid();return;}
        const departing = visibleMotionNodes(id);
        if (departing.length) {
            departing.forEach(node => node.classList.add('inventory-hierarchy-out'));
            await new Promise(resolve => setTimeout(resolve,310));
        }
        renderGrid();
        const arriving = visibleMotionNodes(id);
        arriving.forEach(node => {
            node.classList.add('inventory-hierarchy-in');
            node.addEventListener('animationend',()=>node.classList.remove('inventory-hierarchy-in'),{once:true});
        });
    }

    // Event delegation avoids putting arbitrary item IDs into inline JavaScript.
    document.addEventListener('click', e => {
        const btn = e.target.closest('[data-action][data-id]');
        if (btn) {
            const id = btn.dataset.id;
            if (btn.dataset.action === 'sub') updateQty(id, -1);
            if (btn.dataset.action === 'add') updateQty(id, 1);
            if (btn.dataset.action === 'edit') openModal('edit', id);
            if (btn.dataset.action === 'delete') deleteItem(id);
            return;
        }
        const folder = e.target.closest('[data-folder-id]');
        if (folder) toggleGroup(folder.dataset.folderId);
    });

    // --- INVENTORY ACTIONS ---
    window.updateQty = function(id, delta, source = 'manual') {
        if (isLockedDown || ![-1,1].includes(delta)) return;
        // Quick-adjust controls are intended for repeated taps. Never lock out valid inventory operations.
        const desc = source === 'scan' ? `[ QR SCAN ] -1 UNIT: ${id}` : `UPDATED > ${id}`;
        sendAction({ action: 'stock', id, delta }, desc).catch(() => {});
    };

    window.deleteItem = function(id) {
        if (isLockedDown) return;
        if (confirm(`PURGE ITEM [ ${id} ] FROM CORE MEMORY?`)) {
            sendAction({ action: 'delete', id }, `PURGED > ${id}`, 'warning').catch(() => {});
        }
    };

    // --- MODAL LOGIC BY STRING ID ---
    window.openModal = function(mode, id = null) {
        if (isLockedDown) return;
        const modal = document.getElementById('forgeModal');
        const title = document.getElementById('modalTitle');
        const idInput = document.getElementById('inputId');
        
        if (mode === 'edit' && id) {
            title.innerText = "EDIT EXISTING PROTOCOL";
            document.getElementById('editId').value = id;
            
            let idx = inventory.findIndex(i => i.id === id);
            const item = inventory[idx];
            
            idInput.value = item.id;
            idInput.disabled = false; idInput.style.opacity = '1';
            document.getElementById('inputName').value = item.name;
            document.getElementById('inputManufacturerBarcode').value = item.manufacturerBarcode || '';
            document.getElementById('inputManufacturerBarcodes').value = Array.isArray(item.manufacturerBarcodes) ? item.manufacturerBarcodes.join('\n') : '';
            document.getElementById('inputGroup').value = item.group || '';
            document.getElementById('inputCategory').value = item.category;
            document.getElementById('inputType').value = item.type || '';
            document.getElementById('inputQty').value = item.qty;
            document.getElementById('inputThreshold').value = item.threshold;
        } else {
            title.innerText = "ADD NEW ITEM";
            document.getElementById('editId').value = "";
            idInput.disabled = false; idInput.style.opacity = '1';
            idInput.value = '';
            document.getElementById('inputName').value = '';
            document.getElementById('inputManufacturerBarcode').value = '';
            document.getElementById('inputManufacturerBarcodes').value = '';
            document.getElementById('inputGroup').value = '';
            document.getElementById('inputCategory').value = currentFilter !== 'ALL' ? currentFilter : '';
            document.getElementById('inputType').value = '';
            document.getElementById('inputQty').value = '0';
            document.getElementById('inputThreshold').value = '5';
        }
        modal.classList.add('active');
        if(mode === 'new') idInput.focus();
    };

    window.closeModal = function() { document.getElementById('forgeModal').classList.remove('active'); };
    window.prepareBarcodeCapture = function() {
        const field = document.getElementById('inputManufacturerBarcode');
        field.focus();
        field.select(); // Subsequent capture replaces the old code, not concatenates it.
        triggerStatus('READY: SCAN PACKAGE LABEL INTO FIELD', 'info');
    };

    let itemSavePending = false;
    window.saveItem = async function() {
        if (itemSavePending || isLockedDown) return;
        const editId = document.getElementById('editId').value;
        const item = {
            id: document.getElementById('inputId').value.trim().toUpperCase(),
            name: document.getElementById('inputName').value.trim(),
            manufacturerBarcode: document.getElementById('inputManufacturerBarcode').value.trim(),
            manufacturerBarcodes: document.getElementById('inputManufacturerBarcodes').value.split(/\r?\n/).map(v => v.trim()).filter(Boolean),
            group: document.getElementById('inputGroup').value.trim(),
            category: document.getElementById('inputCategory').value.trim() || 'Uncategorized',
            type: document.getElementById('inputType').value.trim() || 'Unit',
            qty: Number(document.getElementById('inputQty').value),
            threshold: Number(document.getElementById('inputThreshold').value)
        };
        if (!item.id || !item.name) {
            alert('PART ID and NOMENCLATURE are required.'); return;
        }
        if (![item.qty, item.threshold].every(n => Number.isInteger(n) && n >= 0 && n <= 1000000)) {
            alert('Quantity and threshold must be whole numbers between 0 and 1,000,000.'); return;
        }
        const allCodes = [item.id, item.manufacturerBarcode, ...item.manufacturerBarcodes]
            .filter(Boolean).map(v => v.toUpperCase());
        if (item.manufacturerBarcodes.length > 8 || [item.manufacturerBarcode, ...item.manufacturerBarcodes].some(code => code.length > 180)) {
            alert('Use one primary barcode and up to 8 additional labels (180 characters maximum per code).'); return;
        }
        if (new Set(allCodes).size !== allCodes.length) {
            alert('The same barcode cannot appear twice, or be identical to the internal Part ID.'); return;
        }
        itemSavePending = true;
        try {
            await sendAction({ action: editId ? 'edit' : 'add', id: editId || item.id, item },
                `${editId ? 'EDITED' : 'ADDED'} > ${item.id}`);
            closeModal();
        } catch (error) {
            alert(`Could not update item: ${error.message}`);
        } finally {
            itemSavePending = false;
        }
    };

    // --- STATISTICS / MOVEMENT INTELLIGENCE ---
    window.toggleStatistics = function(force) {
        const open = typeof force === 'boolean' ? force : !statsPanelOpen;
        statsPanelOpen = open;
        document.getElementById('statisticsView').hidden = !open;
        for (const selector of ['.category-nav','.action-row','#inventoryWorkspace']) {
            const el = document.querySelector(selector);
            if (el) el.style.display = open ? 'none' : '';
        }
        const button = document.getElementById('statisticsButton');
        button.setAttribute('aria-pressed',String(open));
        button.textContent = open ? '← INVENTORY' : 'STATISTICS';
        if (open) { closeSearchKeyboard({preserveFocus:false});renderStatistics(); }
    };

    function selectedActivity() {
        const windowValue = document.getElementById('statsWindow').value;
        const cutoff = windowValue === 'all' ? -Infinity : Date.now() - Number(windowValue)*86400000;
        return inventoryActivity.filter(e => Date.parse(e.timestamp) >= cutoff);
    }
    const numberDisplay = value => Number(value).toLocaleString('en-US',{maximumFractionDigits:1});
    const q = value => escapeHtml(String(value ?? ''));
    function statsTable(headers, rows, emptyMessage='No matching records yet') {
        if (!rows.length) return `<div class="stats-empty">${q(emptyMessage)}</div>`;
        return `<table class="stats-table"><thead><tr>${headers.map(h=>`<th>${q(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
    }
    function statKpi(name,value,foot,color) {
        return `<article class="stats-kpi" style="--kpi-accent:${color}"><div class="kpi-label">${q(name)}</div><div class="kpi-value">${q(value)}</div><div class="kpi-foot">${q(foot)}</div></article>`;
    }
    function renderStatistics() {
        const target = document.getElementById('statsKpis');
        if (!target) return;
        const events = selectedActivity();
        const movements = events.filter(e=>e.kind==='use'||e.kind==='restock');
        const used = movements.filter(e=>e.kind==='use');
        const received = movements.filter(e=>e.kind==='restock');
        const usedUnits = used.reduce((s,e)=>s+Math.abs(Number(e.delta)||0),0);
        const receivedUnits = received.reduce((s,e)=>s+Math.max(0,Number(e.delta)||0),0);
        const lowItems = inventory.filter(i=>i.qty <= i.threshold);
        const outItems = inventory.filter(i=>i.qty===0);
        const stockedUnits = inventory.reduce((s,i)=>s+i.qty,0);
        const trackDate = inventoryActivity.length ? new Date(Math.min(...inventoryActivity.map(e=>Date.parse(e.timestamp)).filter(Number.isFinite))) : null;
        const windowValue = document.getElementById('statsWindow').value;
        const observedDays = trackDate ? Math.max(1,(Date.now()-Math.max(trackDate.getTime(),windowValue==='all'?-Infinity:Date.now()-Number(windowValue)*86400000))/86400000) : 0;
        const velocity = observedDays ? (usedUnits/observedDays) : 0;
        target.innerHTML = [
          statKpi('ACTIVE ITEMS',inventory.length,'Distinct item IDs','#b4a2ff'),
          statKpi('UNITS ON HAND',numberDisplay(stockedUnits),'Current inventory total','#ffea00'),
          statKpi('LOW / CRITICAL',lowItems.length,`${outItems.length} completely out of stock`,'#ff6677'),
          statKpi('UNITS USED',numberDisplay(usedUnits),`${used.length} withdrawal events`,'#ff7a8f'),
          statKpi('UNITS RESTOCKED',numberDisplay(receivedUnits),`${received.length} additions`,'#1df2ba'),
          statKpi('USE PER DAY',observedDays ? numberDisplay(velocity):'—','Recorded window only','#00f3ff')
        ].join('');
        document.getElementById('statsTrackingInfo').textContent = activityPersistError ?
            `HISTORY WARNING: ${activityPersistError}` :
            activitySource==='folder' ?
                `TRACKING: ${inventoryActivity.length} events • ${trackDate?trackDate.toLocaleDateString():'starts with your next transaction'} • ${selectedDirectoryHandle?.name||'folder'}/${ACTIVITY_FILE}` :
                'SESSION-ONLY HISTORY • Connect VALEO_INVENTORY for persistent reporting.';
        document.getElementById('statsDisclaimer').textContent =
            (activityPersistError ? `WARNING: ${activityPersistError}. ` : '')+
            'Activity tracking starts with the new logging feature; existing stock cannot reconstruct historic consumption. '+
            'Add/Edit item quantities are recorded as administrative changes, not counted as usage or replenishment. '+
            'Daily rates and coverage estimates are directional and need several days of recorded history.';
        const groupedUsed = new Map(), groupedIn = new Map(), catMovements = new Map();
        const addItem = (map,event,units) => {
            const id=event.itemId;
            if(!map.has(id)) map.set(id,{id,name:event.name,qty:0});
            const record=map.get(id);record.qty+=units;
        };
        movements.forEach(e => {
            if(e.kind==='use')addItem(groupedUsed,e,Math.abs(Number(e.delta)||0));
            else addItem(groupedIn,e,Number(e.delta)||0);
            const cat=e.category||'Uncategorized';
            const totals=catMovements.get(cat)||{used:0,in:0};
            totals[e.kind==='use'?'used':'in']+=Math.abs(Number(e.delta)||0);
            catMovements.set(cat,totals);
        });
        const usedRows=[...groupedUsed.values()].sort((a,b)=>b.qty-a.qty).slice(0,12).map(e=>{
            const item=inventory.find(i=>i.id===e.id);
            const rate=observedDays ? e.qty/observedDays : 0;
            // Coverage is omitted when too little history has accumulated.
            const cover=observedDays>=2 && item && rate>0 ? `${(item.qty/rate).toFixed(1)}d` : '—';
            return `<tr><td>${q(e.name)}<div class="subtle">${q(e.id)}</div></td><td class="numeric stats-danger">${numberDisplay(e.qty)}</td><td class="numeric">${item?numberDisplay(item.qty):'—'}</td><td class="numeric">${cover}</td></tr>`;
        });
        document.getElementById('statsMostUsed').innerHTML=statsTable(['ITEM','USED','ON HAND','COVER'],usedRows,'No recorded withdrawals in this period.');
        const inRows=[...groupedIn.values()].sort((a,b)=>b.qty-a.qty).slice(0,12).map(e=>{
            const item=inventory.find(i=>i.id===e.id);
            return `<tr><td>${q(e.name)}<div class="subtle">${q(e.id)}</div></td><td class="numeric stats-success">+${numberDisplay(e.qty)}</td><td class="numeric">${item?numberDisplay(item.qty):'—'}</td></tr>`;
        });
        document.getElementById('statsMostRestocked').innerHTML=statsTable(['ITEM','RECEIVED','ON HAND'],inRows,'No recorded restocks in this period.');
        const alertRows=[...lowItems].sort((a,b)=>a.qty-b.qty||a.name.localeCompare(b.name)).slice(0,25).map(i=>
            `<tr><td>${q(i.name)}<div class="subtle">${q(i.id)}</div></td><td class="numeric stats-danger">${numberDisplay(i.qty)}</td><td class="numeric">${numberDisplay(i.threshold)}</td><td class="numeric">${i.qty===0?'OUT':'LOW'}</td></tr>`);
        document.getElementById('statsLowStock').innerHTML=statsTable(['ITEM','STOCK','MIN','STATUS'],alertRows,'No items are at or below their thresholds.');
        const categories=new Map();
        inventory.forEach(i=>{
            const cat=i.category||'Uncategorized';
            const x=categories.get(cat)||{items:0,units:0,low:0};
            x.items++;x.units+=i.qty;x.low+=+(i.qty<=i.threshold);categories.set(cat,x);
        });
        const catRows=[...categories].sort((a,b)=>b[1].units-a[1].units).map(([cat,e])=>{
            const activity=catMovements.get(cat)||{used:0,in:0};
            return `<tr><td>${q(cat)}</td><td class="numeric">${e.items}</td><td class="numeric">${numberDisplay(e.units)}</td><td class="numeric ${e.low?'stats-danger':''}">${e.low}</td><td class="numeric">${numberDisplay(activity.used)}</td><td class="numeric">${numberDisplay(activity.in)}</td></tr>`;
        });
        document.getElementById('statsByCategory').innerHTML=statsTable(['CATEGORY','ITEMS','UNITS','LOW','USED','IN'],catRows,'No inventory connected.');
        const recentRows=[...events].reverse().slice(0,60).map(e=>{
            const display=e.kind==='use'?'−'+Math.abs(e.delta):e.kind==='restock'?'+'+e.delta:e.kind.toUpperCase();
            return `<tr><td>${q(new Date(e.timestamp).toLocaleString())}</td><td>${q(e.name)}<div class="subtle">${q(e.itemId)} • ${q(e.source)}</div></td><td class="numeric ${e.kind==='use'?'stats-danger':e.kind==='restock'?'stats-success':''}">${q(display)}</td><td class="numeric">${q(e.before)} → ${q(e.after)}</td></tr>`;
        });
        document.getElementById('statsActivity').innerHTML=statsTable(['WHEN','ITEM / SOURCE','CHANGE','STOCK'],recentRows,'No recorded activity in this period.');
        // Chart shows the last 14 days, independent of selected aggregate period.
        const days=Array.from({length:14},(_,i)=>{
            const date=new Date();date.setHours(0,0,0,0);date.setDate(date.getDate()-(13-i));
            return {key:date.toLocaleDateString('en-CA'),date,used:0,restocked:0};
        });
        for(const event of inventoryActivity){
            if(!['use','restock'].includes(event.kind))continue;
            const d=new Date(event.timestamp);
            const key=d.toLocaleDateString('en-CA');
            const row=days.find(x=>x.key===key);
            if(row)row[event.kind==='use'?'used':'restocked']+=Math.abs(Number(event.delta)||0);
        }
        const top=Math.max(1,...days.flatMap(d=>[d.used,d.restocked]));
        document.getElementById('statsChart').innerHTML=days.map(d=>{
            const usedHeight=d.used?Math.max(3,d.used/top*145):0;
            const inHeight=d.restocked?Math.max(3,d.restocked/top*145):0;
            return `<div class="stats-day" title="${q(d.date.toDateString())}: ${d.used} used, ${d.restocked} received"><div class="stats-day-bars"><span class="bar-used" style="height:${usedHeight}px"></span><span class="bar-in" style="height:${inHeight}px"></span></div><div class="stats-day-label">${d.date.getMonth()+1}/${d.date.getDate()}</div></div>`;
        }).join('');
    }
    window.renderStatistics=renderStatistics;
    window.exportActivityCSV = function() {
        if (!inventoryActivity.length) {triggerStatus('NO ACTIVITY RECORDED TO EXPORT','warning');return;}
        const headers=['timestamp','kind','source','itemId','name','category','before','after','delta'];
        const csvCell = v => '"'+String(v??'').replace(/"/g,'""')+'"';
        const csv=[headers.join(','),...selectedActivity().map(e=>headers.map(h=>csvCell(e[h])).join(','))].join('\r\n');
        const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
        const link=document.createElement('a');link.href=url;link.download='VALEO_Inventory_Activity.csv';
        document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),10000);
        triggerStatus('ACTIVITY CSV EXPORTED','success');
    };


    // BOOT SEQUENCE
    window.onload = () => {
        loadInventory();
        // Finish after two seconds, including the final fade. No screen wipe.
        setTimeout(() => document.getElementById('inventoryBoot')?.remove(),2000);
        // Desktop mode: use the original VALEO_INVENTORY/inventory.json, not ESP32 API.
    };

// ---------- GLOBAL STATE ----------
let rawSmsList = [];
let contactMap = new Map();
let contactList = [];
let currentSelectedAddress = "ALL";
let currentSearchTerm = "";
let currentSortOrder = "newest";
let currentMessageType = "ALL"; // "ALL", "SENT", "RECEIVED"
let startDate = null;
let endDate = null;
let isDataLoaded = false;

// Infinite scroll state
let currentlyDisplayedMessages = [];
let currentBatch = 0;
const BATCH_SIZE = 100;
let isLoadingMore = false;
let hasMoreMessages = true;
let scrollObserver = null;

// DOM elements
const fileInput = document.getElementById('smsFileInput');
const fileStatsSpan = document.getElementById('fileStats');
const controlsDiv = document.getElementById('controlsSection');
const searchInput = document.getElementById('searchInput');
const startDateInput = document.getElementById('startDateInput');
const endDateInput = document.getElementById('endDateInput');
const clearDateBtn = document.getElementById('clearDateBtn');
const messagesContainer = document.getElementById('messagesList');
const resultCountSpan = document.getElementById('resultCountBadge');
const globalInfoDiv = document.getElementById('globalInfo');
const sortNewestBtn = document.getElementById('sortNewestBtn');
const sortOldestBtn = document.getElementById('sortOldestBtn');
const darkModeToggle = document.getElementById('darkModeToggle');
const filterAllBtn = document.getElementById('filterAllBtn');
const filterSentBtn = document.getElementById('filterSentBtn');
const filterReceivedBtn = document.getElementById('filterReceivedBtn');

const selectedContactDisplay = document.getElementById('selectedContactDisplay');
const contactDropdown = document.getElementById('contactDropdown');
const contactSearchInput = document.getElementById('contactSearchInput');
const dropdownItemsContainer = document.getElementById('dropdownItemsContainer');

// ---------- DARK MODE ----------
function initDarkMode() {
	const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
	const saved = localStorage.getItem('sms_theme');
	if (saved === 'dark' || (!saved && prefersDark)) {
		document.body.classList.add('dark');
		darkModeToggle.innerHTML = '☀️ Light Mode';
	} else {
		document.body.classList.remove('dark');
		darkModeToggle.innerHTML = '🌙 Dark Mode';
	}
}
darkModeToggle.addEventListener('click', () => {
	if (document.body.classList.contains('dark')) {
		document.body.classList.remove('dark');
		localStorage.setItem('sms_theme', 'light');
		darkModeToggle.innerHTML = '🌙 Dark Mode';
	} else {
		document.body.classList.add('dark');
		localStorage.setItem('sms_theme', 'dark');
		darkModeToggle.innerHTML = '☀️ Light Mode';
	}
});
initDarkMode();

// ---------- DATE PROCESSING ----------
function parseTimestamp(value) {
	if (!value || value === "null" || value === "undefined") return null;
	const num = parseInt(value);
	if (isNaN(num) || num <= 0) return null;
	return num;
}

function getTimestampMs(smsObj) {
	let ts = parseTimestamp(smsObj.date_sent);
	if (ts !== null && ts > 0) return ts;
	ts = parseTimestamp(smsObj.date);
	if (ts !== null && ts > 0) return ts;
	return Date.now();
}

function getMessageDateObj(smsObj) {
	const ts = getTimestampMs(smsObj);
	if (ts > 0) {
		const d = new Date(ts);
		if (!isNaN(d.getTime())) {
			return new Date(d.getFullYear(), d.getMonth(), d.getDate());
		}
	}
	return null;
}

function formatDisplayDate(smsObj) {
	if (smsObj.readable_date && smsObj.readable_date !== "null" && smsObj.readable_date.trim() !== "") {
		return smsObj.readable_date;
	}
	const ts = getTimestampMs(smsObj);
	if (ts > 0) {
		const d = new Date(ts);
		if (!isNaN(d.getTime())) {
			return d.toLocaleString(undefined, { 
				year: 'numeric', 
				month: 'short', 
				day: 'numeric',
				hour: '2-digit',
				minute: '2-digit'
			});
		}
	}
	return "Unknown date";
}

function getShortDateKey(timestamp) {
	const d = new Date(timestamp);
	return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

// Parse XML to sms array
function parseXmlToSmsArray(xmlString) {
	const parser = new DOMParser();
	const xmlDoc = parser.parseFromString(xmlString, "text/xml");
	const parserError = xmlDoc.querySelector('parsererror');
	if (parserError) throw new Error("Invalid XML: " + parserError.textContent);
	
	const smsNodes = xmlDoc.getElementsByTagName("sms");
	if (!smsNodes.length) throw new Error("No <sms> elements found.");
	
	const smsArray = [];
	for (let i = 0; i < smsNodes.length; i++) {
		const node = smsNodes[i];
		const attrs = node.attributes;
		const record = {};
		
		for (let j = 0; j < attrs.length; j++) {
			record[attrs[j].name] = attrs[j].value;
		}
		
		if (!record.body) record.body = "";
		if (!record.address || record.address === "null" || record.address === "") {
			record.address = "(Unknown)";
		}
		
		let contactName = null;
		if (record.contact_name && record.contact_name !== "null" && record.contact_name.trim() !== "") {
			contactName = record.contact_name;
		}
		record._contactName = contactName;
		record._timestamp = getTimestampMs(record);
		
		// Determine message type: 1 = received, 2 = sent
		record._isSent = (record.type === "2");
		
		smsArray.push(record);
	}
	
	return smsArray;
}

// Build contact map
function buildContactMap() {
	contactMap.clear();
	for (const sms of rawSmsList) {
		const addr = sms.address;
		if (!contactMap.has(addr)) {
			contactMap.set(addr, { address: addr, name: null, count: 0 });
		}
		const contact = contactMap.get(addr);
		contact.count++;
		
		if (sms._contactName && sms._contactName !== "(Unknown)" && sms._contactName !== "null") {
			if (!contact.name || contact.name === addr || contact.name === "(Unknown)") {
				contact.name = sms._contactName;
			}
		} else if (!contact.name) {
			contact.name = addr;
		}
	}
	
	for (let [addr, contact] of contactMap.entries()) {
		if (!contact.name || contact.name === "null") contact.name = addr;
	}
	
	contactList = Array.from(contactMap.values());
	contactList.sort((a, b) => a.name.localeCompare(b.name, 'fa'));
}

function isWithinDateRange(sms) {
	if (!startDate && !endDate) return true;
	const msgDate = getMessageDateObj(sms);
	if (!msgDate) return !startDate && !endDate;
	if (startDate && msgDate < startDate) return false;
	if (endDate && msgDate > endDate) return false;
	return true;
}

function matchesMessageType(sms) {
	if (currentMessageType === "ALL") return true;
	if (currentMessageType === "SENT") return sms._isSent === true;
	if (currentMessageType === "RECEIVED") return sms._isSent === false;
	return true;
}

function updateMasterFilteredList() {
	let filtered = [...rawSmsList];
	
	// Contact filter
	if (currentSelectedAddress !== "ALL") {
		filtered = filtered.filter(sms => sms.address === currentSelectedAddress);
	}
	
	// Message type filter (sent/received)
	filtered = filtered.filter(sms => matchesMessageType(sms));
	
	// Date range filter
	filtered = filtered.filter(sms => isWithinDateRange(sms));
	
	// Body search filter
	if (currentSearchTerm.trim() !== "") {
		const term = currentSearchTerm.trim().toLowerCase();
		filtered = filtered.filter(sms => (sms.body || "").toLowerCase().includes(term));
	}
	
	// Sort by timestamp
	if (currentSortOrder === "newest") {
		filtered.sort((a, b) => (b._timestamp || 0) - (a._timestamp || 0));
	} else {
		filtered.sort((a, b) => (a._timestamp || 0) - (b._timestamp || 0));
	}
	
	return filtered;
}

// Render message as chat bubble - NOW SHOWING PHONE NUMBER INSTEAD OF SERVICE CENTER
function renderMessageBubble(sms, showDateSeparator = false, dateKey = null) {
	let html = '';
	
	if (showDateSeparator && dateKey) {
		const dateObj = new Date(sms._timestamp);
		const formattedDate = dateObj.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
		html += `<div class="date-separator"><span>📅 ${formattedDate}</span></div>`;
	}
	
	const isSent = sms._isSent;
	const bubbleClass = isSent ? 'message-sent' : 'message-received';
	const bubbleStyle = isSent ? 'bubble-sent' : 'bubble-received';
	
	const addressRaw = sms.address || "(Unknown)";
	const displayAddress = escapeHtml(addressRaw);
	const bodyRaw = sms.body || "";
	const displayBody = escapeHtml(bodyRaw).replace(/\n/g, '<br>');
	const dateStr = formatDisplayDate(sms);
	const typeIcon = isSent ? '📤' : '📩';
	const typeLabel = isSent ? 'Sent To' : 'Received From';
	const contactName = sms._contactName && sms._contactName !== "null" ? sms._contactName : null;
	const senderDisplay = contactName ? escapeHtml(contactName) : displayAddress;
	
	html += `
		<div class="message-bubble ${bubbleClass}">
			<div class="bubble ${bubbleStyle}">
				<div class="message-header">
					<span class="sender-name">${typeIcon} ${senderDisplay}</span>
					<span class="message-time">${escapeHtml(dateStr)}</span>
				</div>
				<div class="message-body">${displayBody || '<em style="opacity:0.6;">[empty message]</em>'}</div>
				<div class="message-meta">
					<span class="status-icon">${typeLabel}</span>
					<span class="phone-number">📞 ${displayAddress}</span>
				</div>
			</div>
		</div>
	`;
	
	return html;
}

// Group messages by date and render with separators
function renderGroupedMessages(messages) {
	if (messages.length === 0) return '';
	
	let html = '';
	let lastDateKey = null;
	
	for (const sms of messages) {
		const dateKey = getShortDateKey(sms._timestamp);
		const showSeparator = (lastDateKey !== dateKey);
		html += renderMessageBubble(sms, showSeparator, dateKey);
		lastDateKey = dateKey;
	}
	
	return html;
}

// Infinite scroll functions
function loadNextBatch() {
	if (isLoadingMore || !hasMoreMessages) return;
	isLoadingMore = true;
	
	const startIdx = currentBatch * BATCH_SIZE;
	const nextBatchMessages = currentlyDisplayedMessages.slice(startIdx, startIdx + BATCH_SIZE);
	
	if (nextBatchMessages.length === 0) {
		hasMoreMessages = false;
		isLoadingMore = false;
		removeLoaderTrigger();
		return;
	}
	
	const batchHtml = renderGroupedMessages(nextBatchMessages);
	const existingLoader = document.getElementById('scroll-loader-trigger');
	if (existingLoader) existingLoader.remove();
	messagesContainer.insertAdjacentHTML('beforeend', batchHtml);
	currentBatch++;
	
	if (startIdx + BATCH_SIZE >= currentlyDisplayedMessages.length) {
		hasMoreMessages = false;
		removeLoaderTrigger();
	} else {
		const loaderHtml = `<div id="scroll-loader-trigger" class="loader-trigger"><div class="loading-spinner"></div> Loading more messages (${Math.min(currentBatch * BATCH_SIZE, currentlyDisplayedMessages.length)}/${currentlyDisplayedMessages.length})...</div>`;
		messagesContainer.insertAdjacentHTML('beforeend', loaderHtml);
		setupScrollObserver();
	}
	isLoadingMore = false;
}

function setupScrollObserver() {
	if (scrollObserver) scrollObserver.disconnect();
	const loaderElement = document.getElementById('scroll-loader-trigger');
	if (!loaderElement) return;
	scrollObserver = new IntersectionObserver((entries) => {
		if (entries[0].isIntersecting && hasMoreMessages && !isLoadingMore) {
			loadNextBatch();
		}
	}, { threshold: 0.3 });
	scrollObserver.observe(loaderElement);
}

function removeLoaderTrigger() {
	if (scrollObserver) {
		scrollObserver.disconnect();
		scrollObserver = null;
	}
	const loader = document.getElementById('scroll-loader-trigger');
	if (loader) loader.remove();
}

function resetAndRenderBatches() {
	currentBatch = 0;
	hasMoreMessages = true;
	isLoadingMore = false;
	if (scrollObserver) {
		scrollObserver.disconnect();
		scrollObserver = null;
	}
	
	currentlyDisplayedMessages = updateMasterFilteredList();
	messagesContainer.innerHTML = '';
	
	if (currentlyDisplayedMessages.length === 0) {
		let filterDesc = "";
		if (currentMessageType === "SENT") filterDesc = "sent ";
		else if (currentMessageType === "RECEIVED") filterDesc = "received ";
		messagesContainer.innerHTML = `<div class="no-messages">🔍 No ${filterDesc}messages match the filters.<br>Try different contact, date range, or keyword.</div>`;
		resultCountSpan.innerText = "0 messages";
		const dateInfo = (startDate || endDate) ? ` | Date filtered` : '';
		globalInfoDiv.innerHTML = `No messages found${dateInfo}. Total in backup: ${rawSmsList.length}`;
		return;
	}
	
	resultCountSpan.innerText = `${currentlyDisplayedMessages.length} message${currentlyDisplayedMessages.length !== 1 ? 's' : ''}`;
	
	const firstBatch = currentlyDisplayedMessages.slice(0, BATCH_SIZE);
	const firstBatchHtml = renderGroupedMessages(firstBatch);
	messagesContainer.innerHTML = firstBatchHtml;
	currentBatch = 1;
	
	if (firstBatch.length < currentlyDisplayedMessages.length) {
		const loaderHtml = `<div id="scroll-loader-trigger" class="loader-trigger"><div class="loading-spinner"></div> Loading more messages (${firstBatch.length}/${currentlyDisplayedMessages.length})...</div>`;
		messagesContainer.insertAdjacentHTML('beforeend', loaderHtml);
		setupScrollObserver();
	} else {
		hasMoreMessages = false;
	}
	
	let dateRangeText = '';
	if (startDate && endDate) dateRangeText = `📅 ${startDate.toLocaleDateString()} → ${endDate.toLocaleDateString()}`;
	else if (startDate) dateRangeText = `📅 From ${startDate.toLocaleDateString()}`;
	else if (endDate) dateRangeText = `📅 Until ${endDate.toLocaleDateString()}`;
	
	const sentCount = currentlyDisplayedMessages.filter(m => m._isSent).length;
	const receivedCount = currentlyDisplayedMessages.length - sentCount;
	
	let typeFilterText = "";
	if (currentMessageType === "SENT") typeFilterText = " (Sent only)";
	else if (currentMessageType === "RECEIVED") typeFilterText = " (Received only)";
	
	globalInfoDiv.innerHTML = `✅ ${currentlyDisplayedMessages.length} messages${typeFilterText} (📤 ${sentCount} sent, 📩 ${receivedCount} received) | Sorted: ${currentSortOrder === "newest" ? "newest first" : "oldest first"} ${dateRangeText ? '| ' + dateRangeText : ''}`;
}

function escapeHtml(str) {
	if (!str) return '';
	return str.replace(/[&<>]/g, function(m) {
		if (m === '&') return '&amp;';
		if (m === '<') return '&lt;';
		if (m === '>') return '&gt;';
		return m;
	});
}

function escapeHtmlAttr(str) {
	if (!str) return '';
	return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function decodeHtmlEntity(str) {
	let textarea = document.createElement('textarea');
	textarea.innerHTML = str;
	return textarea.value;
}

// Dropdown rendering
function renderDropdownItems(filterText = "") {
	const query = filterText.trim().toLowerCase();
	let filteredContacts = contactList;
	if (query !== "") {
		filteredContacts = contactList.filter(contact => {
			return contact.name.toLowerCase().includes(query) || contact.address.toLowerCase().includes(query);
		});
	}
	let itemsHtml = `<div class="dropdown-item ${currentSelectedAddress === "ALL" ? 'selected' : ''}" data-address="ALL">
						<div class="contact-info">
							<div class="contact-name">📨 ALL CONTACTS</div>
							<div class="contact-address">${rawSmsList.length} total messages</div>
						</div>
						<span class="item-count">${rawSmsList.length}</span>
					 </div>`;
	for (const contact of filteredContacts) {
		const isSelected = (currentSelectedAddress === contact.address);
		itemsHtml += `<div class="dropdown-item ${isSelected ? 'selected' : ''}" data-address="${escapeHtmlAttr(contact.address)}">
						<div class="contact-info">
							<div class="contact-name">${escapeHtml(contact.name)}</div>
							<div class="contact-address">📞 ${escapeHtml(contact.address)}</div>
						</div>
						<span class="item-count">${contact.count}</span>
					  </div>`;
	}
	dropdownItemsContainer.innerHTML = itemsHtml;
	document.querySelectorAll('.dropdown-item').forEach(item => {
		item.addEventListener('click', (e) => {
			e.stopPropagation();
			const rawAddr = item.getAttribute('data-address');
			if (rawAddr === "ALL") {
				currentSelectedAddress = "ALL";
				updateSelectedDisplay("📨 ALL CONTACTS");
			} else {
				const decodedAddr = decodeHtmlEntity(rawAddr);
				currentSelectedAddress = decodedAddr;
				const contact = contactMap.get(decodedAddr);
				updateSelectedDisplay(contact ? contact.name : decodedAddr);
			}
			closeDropdown();
			resetAndRenderBatches();
		});
	});
}

function updateSelectedDisplay(name) {
	const spanElem = selectedContactDisplay.querySelector('span:first-child');
	if (currentSelectedAddress === "ALL") {
		if (spanElem) spanElem.innerText = "📨 ALL CONTACTS";
	} else {
		const shortName = name.length > 40 ? name.substring(0, 38) + '..' : name;
		if (spanElem) spanElem.innerText = `📞 ${shortName}`;
	}
}

function toggleDropdown() {
	if (contactDropdown.classList.contains('show')) closeDropdown();
	else openDropdown();
}
function openDropdown() {
	renderDropdownItems(contactSearchInput.value);
	contactDropdown.classList.add('show');
	contactSearchInput.focus();
	setTimeout(() => document.addEventListener('click', outsideClickListener), 0);
}
function closeDropdown() {
	contactDropdown.classList.remove('show');
	document.removeEventListener('click', outsideClickListener);
}
function outsideClickListener(e) {
	if (!selectedContactDisplay.contains(e.target) && !contactDropdown.contains(e.target)) closeDropdown();
}
function onContactSearchInput() { renderDropdownItems(contactSearchInput.value); }

function updateDateFilters() {
	if (startDateInput.value) {
		startDate = new Date(startDateInput.value);
		startDate.setHours(0, 0, 0, 0);
	} else {
		startDate = null;
	}
	if (endDateInput.value) {
		endDate = new Date(endDateInput.value);
		endDate.setHours(23, 59, 59, 999);
	} else {
		endDate = null;
	}
	resetAndRenderBatches();
}

function clearDateFilters() {
	startDateInput.value = '';
	endDateInput.value = '';
	startDate = null;
	endDate = null;
	resetAndRenderBatches();
}

function setMessageTypeFilter(type) {
	currentMessageType = type;
	filterAllBtn.classList.remove('active');
	filterSentBtn.classList.remove('active');
	filterReceivedBtn.classList.remove('active');
	
	if (type === "ALL") filterAllBtn.classList.add('active');
	else if (type === "SENT") filterSentBtn.classList.add('active');
	else if (type === "RECEIVED") filterReceivedBtn.classList.add('active');
	
	resetAndRenderBatches();
}

function refreshUI() {
	if (!isDataLoaded) return;
	buildContactMap();
	updateSelectedDisplay(currentSelectedAddress === "ALL" ? "ALL" : (contactMap.get(currentSelectedAddress)?.name || "Contact"));
	renderDropdownItems(contactSearchInput.value);
	resetAndRenderBatches();
	fileStatsSpan.innerText = `${rawSmsList.length} msgs | ${contactList.length} contacts`;
	controlsDiv.style.display = "block";
}

function processUploadedFile(file) {
	if (!file) return;
	fileStatsSpan.innerText = `Processing ${file.name}...`;
	globalInfoDiv.innerHTML = "Parsing XML...";
	const reader = new FileReader();
	reader.onload = function(e) {
		try {
			const xmlContent = e.target.result;
			if (!xmlContent.includes("<sms")) throw new Error("Missing <sms> tags.");
			const parsed = parseXmlToSmsArray(xmlContent);
			if (parsed.length === 0) throw new Error("No SMS entries found.");
			rawSmsList = parsed;
			isDataLoaded = true;
			currentSelectedAddress = "ALL";
			currentSearchTerm = "";
			currentMessageType = "ALL";
			filterAllBtn.classList.add('active');
			filterSentBtn.classList.remove('active');
			filterReceivedBtn.classList.remove('active');
			searchInput.value = "";
			contactSearchInput.value = "";
			currentSortOrder = "newest";
			startDate = null;
			endDate = null;
			startDateInput.value = '';
			endDateInput.value = '';
			sortNewestBtn.classList.add('active');
			sortOldestBtn.classList.remove('active');
			buildContactMap();
			refreshUI();
		} catch (err) {
			globalInfoDiv.innerHTML = `❌ Error: ${err.message}`;
			fileStatsSpan.innerText = "Parsing failed";
			controlsDiv.style.display = "none";
			messagesContainer.innerHTML = `<div class="no-messages">XML Error: ${escapeHtml(err.message)}</div>`;
			isDataLoaded = false;
		}
	};
	reader.onerror = () => { globalInfoDiv.innerHTML = "File read error."; };
	reader.readAsText(file, "UTF-8");
}

// Event listeners
fileInput.addEventListener('change', (e) => {
	const file = e.target.files[0];
	if (file) processUploadedFile(file);
	else { rawSmsList = []; isDataLoaded = false; controlsDiv.style.display = "none"; messagesContainer.innerHTML = '<div class="no-messages">No file selected.</div>'; fileStatsSpan.innerText = "No file"; }
});

selectedContactDisplay.addEventListener('click', (e) => { e.stopPropagation(); if (isDataLoaded) toggleDropdown(); });
contactSearchInput.addEventListener('input', onContactSearchInput);
searchInput.addEventListener('input', () => { currentSearchTerm = searchInput.value; resetAndRenderBatches(); });
startDateInput.addEventListener('change', updateDateFilters);
endDateInput.addEventListener('change', updateDateFilters);
clearDateBtn.addEventListener('click', clearDateFilters);

filterAllBtn.addEventListener('click', () => setMessageTypeFilter("ALL"));
filterSentBtn.addEventListener('click', () => setMessageTypeFilter("SENT"));
filterReceivedBtn.addEventListener('click', () => setMessageTypeFilter("RECEIVED"));

sortNewestBtn.addEventListener('click', () => { 
	currentSortOrder = "newest"; 
	sortNewestBtn.classList.add('active'); 
	sortOldestBtn.classList.remove('active'); 
	resetAndRenderBatches(); 
});

sortOldestBtn.addEventListener('click', () => { 
	currentSortOrder = "oldest"; 
	sortOldestBtn.classList.add('active'); 
	sortNewestBtn.classList.remove('active'); 
	resetAndRenderBatches(); 
});

document.addEventListener('click', (e) => { 
	if (!selectedContactDisplay.contains(e.target) && !contactDropdown.contains(e.target)) closeDropdown(); 
});

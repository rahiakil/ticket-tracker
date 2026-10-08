var FILE_NAME = "ticket-tracker-scans.txt";
var FOLDER_ID = "1r679tCaeKA5-y4sXuUEX3xB2GCxx7Xg7";

function doGet(e) {
  var book = readBook_();
  var url = liveSheetUrl_();
  if (url) book.sheetUrl = url;
  var salesId = PropertiesService.getScriptProperties().getProperty("SALES_SHEET_ID");
  if (salesId) book.salesSheetUrl = "https://docs.google.com/spreadsheets/d/" + salesId + "/edit?usp=sharing";
  var body = JSON.stringify(book);
  var callback = e && e.parameter ? e.parameter.callback : "";
  if (callback && /^[A-Za-z0-9_]+$/.test(callback)) {
    return ContentService.createTextOutput(callback + "(" + body + ")")
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(body).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var raw = "";
  if (e && e.parameter && e.parameter.payload) raw = e.parameter.payload;
  else if (e && e.postData && e.postData.contents) raw = e.postData.contents;
  var book = JSON.parse(raw);
  if (!book || book.schemaVersion !== 1 || !book.orders || !Array.isArray(book.lines)) {
    return ContentService.createTextOutput("bad").setMimeType(ContentService.MimeType.TEXT);
  }
  var merged = mergeBook_(readBook_(), book);
  merged = publishLiveSheet_(merged);
  writeBook_(merged);
  return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
}

function liveSheetUrl_() {
  var id = PropertiesService.getScriptProperties().getProperty("SHEET_ID");
  if (!id) return "";
  return "https://docs.google.com/spreadsheets/d/" + id + "/edit?usp=sharing";
}

function ensureLiveSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("SHEET_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) {}
  }
  var ss = SpreadsheetApp.create("Uttoron ticket status");
  var file = DriveApp.getFileById(ss.getId());
  file.moveTo(DriveApp.getFolderById(FOLDER_ID));
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (err) {}
  props.setProperty("SHEET_ID", ss.getId());
  return ss;
}

function publishLiveSheet_(book) {
  if (!book || !book.statusGrid || !book.statusGrid.length) return book;
  try {
    var ss = ensureLiveSheet_();
    var sheet = ss.getSheets()[0];
    sheet.setName("Status");
    var grid = book.statusGrid;
    var width = 1;
    grid.forEach(function (row) { if (row.length > width) width = row.length; });
    var values = grid.map(function (row) {
      var copy = row.slice();
      while (copy.length < width) copy.push("");
      return copy;
    });
    sheet.clear();
    sheet.getRange(1, 1, values.length, width).setValues(values);
    sheet.getRange(1, 1, 1, width).setFontWeight("bold");
    sheet.setFrozenRows(1);
    book.sheetUrl = ss.getUrl();
    var statsSheet = ss.getSheetByName("Stats");
    if (!statsSheet) statsSheet = ss.insertSheet("Stats");
    writeGrid_(statsSheet, book.statsGrid || []);
    writeGrid_(ensureSalesBook_().getSheets()[0], book.onSiteGrid || []);
    book.salesSheetUrl = "https://docs.google.com/spreadsheets/d/" + PropertiesService.getScriptProperties().getProperty("SALES_SHEET_ID") + "/edit?usp=sharing";
  } catch (err) {
    book.sheetUrl = liveSheetUrl_();
  }
  delete book.statusGrid;
  delete book.onSiteGrid;
  delete book.statsGrid;
  delete book.publishSheet;
  return book;
}

function writeGrid_(sheet, grid) {
  if (!grid || !grid.length) return;
  var width = 1;
  grid.forEach(function (row) { if (row.length > width) width = row.length; });
  var values = grid.map(function (row) {
    var copy = row.slice();
    while (copy.length < width) copy.push("");
    return copy;
  });
  sheet.clear();
  sheet.getRange(1, 1, values.length, width).setValues(values);
  sheet.getRange(1, 1, 1, width).setFontWeight("bold");
  sheet.setFrozenRows(1);
}

function ensureSalesBook_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty("SALES_SHEET_ID");
  if (id) {
    try { return SpreadsheetApp.openById(id); } catch (err) {}
  }
  var ss = SpreadsheetApp.create("Uttoron on site sales");
  var file = DriveApp.getFileById(ss.getId());
  file.moveTo(DriveApp.getFolderById(FOLDER_ID));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (err2) {}
  props.setProperty("SALES_SHEET_ID", ss.getId());
  ss.getSheets()[0].setName("On site sales");
  return ss;
}

function keepSheet_(current, incoming) {
  if (incoming && incoming.sheet && incoming.sheet.orders) current.sheet = incoming.sheet;
}

function lockFresh_(lock) {
  if (!lock || !lock.holder || !lock.at) return false;
  var age = Date.now() - Date.parse(lock.at);
  return age >= 0 && age < 3 * 60 * 1000;
}

function mergeBook_(current, incoming) {
  if (!current.locks) current.locks = {};
  if (incoming && incoming.cleanupAll && incoming.allowCleanup) {
    current.orders = {};
    current.lines = incoming.lines || [];
    current.log = incoming.log || [];
    current.locks = {};
    current.cleanupAll = false;
    current.releaseAllLocks = false;
    current.baseWriteId = "";
    current.lastWriteId = incoming.lastWriteId || "";
    current.counts = countBook_(current);
    keepSheet_(current, incoming);
    keepAccounts_(current, incoming);
    return current;
  }
  if (incoming && incoming.releaseAllLocks && incoming.actor === "siteadmin") {
    current.locks = {};
    current.releaseAllLocks = false;
    current.log = mergeLog_(current.log, incoming.log);
    current.lastWriteId = incoming.lastWriteId || current.lastWriteId || "";
    current.counts = countBook_(current);
    keepSheet_(current, incoming);
    keepAccounts_(current, incoming);
    return current;
  }
  if (String(incoming.baseWriteId || "") === String(current.lastWriteId || "")) {
    current.orders = incoming.orders || {};
    current.lines = incoming.lines || [];
    current.log = incoming.log || [];
    current.locks = incoming.locks || {};
    current.walkups = incoming.walkups || {};
    current.disputes = incoming.disputes || [];
    (incoming.releasedLocks || []).forEach(function (code) {
      if (current.locks[code] && current.locks[code].holder === incoming.releasedBy) delete current.locks[code];
    });
    current.releasedLocks = [];
    current.baseWriteId = "";
    current.lastWriteId = incoming.lastWriteId || "";
    pruneOld_(current);
    current.counts = countBook_(current);
    keepSheet_(current, incoming);
    keepAccounts_(current, incoming);
    return current;
  }
  var orders = current.orders || {};
  var incomingOrders = incoming.orders || {};
  var incomingLocks = incoming.locks || {};
  Object.keys(incomingOrders).forEach(function (orderId) {
    var prior = orders[orderId];
    var next = incomingOrders[orderId];
    if (!prior) {
      orders[orderId] = next;
      return;
    }
    var priorLock = current.locks[orderId];
    var nextLock = incomingLocks[orderId];
    if (lockFresh_(priorLock) && (!nextLock || nextLock.holder !== priorLock.holder)) return;
    var variants = prior.variants || {};
    Object.keys(next.variants || {}).forEach(function (variantId) {
      var before = variants[variantId];
      var after = next.variants[variantId];
      if (before && before.taken && after && !after.taken) {
        if (next.revertKey !== variantId) return;
      }
      if (before && before.taken && after && after.taken) {
        variants[variantId] = before;
        return;
      }
      variants[variantId] = after;
    });
    prior.variants = variants;
    if (typeof next.takenCount === "number") prior.takenCount = next.takenCount;
    prior.raw = next.raw || prior.raw;
    prior.updatedAt = next.updatedAt || prior.updatedAt;
    orders[orderId] = prior;
  });
  Object.keys(incomingLocks).forEach(function (code) {
    var priorLock = current.locks[code];
    var nextLock = incomingLocks[code];
    if (lockFresh_(priorLock) && priorLock.holder !== nextLock.holder) return;
    current.locks[code] = nextLock;
  });
  (incoming.releasedLocks || []).forEach(function (code) {
    if (current.locks[code] && (!lockFresh_(current.locks[code]) || current.locks[code].holder === incoming.releasedBy)) {
      delete current.locks[code];
    }
  });
  current.orders = orders;
  var seenLines = {};
  var lines = [];
  (current.lines || []).concat(incoming.lines || []).forEach(function (line) {
    if (seenLines[line]) return;
    seenLines[line] = true;
    lines.push(line);
  });
  current.lines = lines;
  current.log = mergeLog_(current.log, incoming.log);
  current.walkups = Object.assign({}, current.walkups || {}, incoming.walkups || {});
  current.disputes = incoming.disputes || current.disputes || [];
  current.lastWriteId = incoming.lastWriteId || current.lastWriteId || "";
  pruneOld_(current);
  current.counts = countBook_(current);
  keepSheet_(current, incoming);
  keepAccounts_(current, incoming);
  return current;
}

function keepAccounts_(current, incoming) {
  if (incoming && incoming.accountsWrite && Array.isArray(incoming.accounts)) {
    current.accounts = incoming.accounts.filter(function (account) {
      return account && /^[a-z0-9][a-z0-9-]{1,31}$/.test(String(account.username || ""))
        && /^[a-f0-9]{64}$/.test(String(account.hash || ""))
        && ["records", "scanner", "desk", "food"].indexOf(String(account.role || "")) >= 0;
    }).map(function (account) {
      var role = String(account.role);
      var abilities = {};
      ["scan", "add", "edit", "search", "sell", "admin"].forEach(function (key) {
        abilities[key] = Boolean(account.abilities && account.abilities[key]);
      });
      if (role === "records") {
        ["scan", "add", "edit", "search", "sell", "admin"].forEach(function (key) { abilities[key] = true; });
      }
      return {
        username: String(account.username).trim().toLowerCase(),
        hash: String(account.hash),
        role: role,
        abilities: abilities,
      };
    });
  }
  current.accountsWrite = false;
}

function mergeLog_(currentLog, incomingLog) {
  var seen = {};
  var log = [];
  (currentLog || []).concat(incomingLog || []).forEach(function (item) {
    if (!item || !item.at) return;
    var key = item.at + "|" + item.text;
    if (seen[key]) return;
    seen[key] = true;
    log.push(item);
  });
  return log;
}

function pruneOld_(book) {
  var maxOrders = 10000;
  var ids = Object.keys(book.orders || {});
  ids.sort(function (left, right) {
    var leftTime = Date.parse(book.orders[left].updatedAt || book.orders[left].scannedAt || 0);
    var rightTime = Date.parse(book.orders[right].updatedAt || book.orders[right].scannedAt || 0);
    return leftTime - rightTime;
  });
  while (ids.length > maxOrders) delete book.orders[ids.shift()];
  if ((book.log || []).length > maxOrders) book.log = book.log.slice(book.log.length - maxOrders);
  if ((book.lines || []).length > maxOrders) book.lines = book.lines.slice(book.lines.length - maxOrders);
}

function countBook_(book) {
  var orders = [];
  var variants = {};
  Object.keys(book.orders || {}).forEach(function (orderId) {
    orders.push(book.orders[orderId]);
  });
  orders.forEach(function (order) {
    Object.keys(order.variants || {}).forEach(function (variantId) {
      if (!variants[variantId]) variants[variantId] = { orders: 0, taken: 0, notTaken: 0 };
      variants[variantId].orders += 1;
      if (order.variants[variantId].taken) variants[variantId].taken += 1;
      else variants[variantId].notTaken += 1;
    });
  });
  var ticketsTaken = 0;
  orders.forEach(function (order) {
    var total = Object.keys(order.variants || {}).length;
    var taken = typeof order.takenCount === "number" ? order.takenCount : 0;
    if (taken < 0) taken = 0;
    if (taken > total) taken = total;
    ticketsTaken += taken;
  });
  return { peopleScanned: orders.length, ticketsTaken: ticketsTaken, variants: variants };
}

function readBook_() {
  var text = findFile_().getBlob().getDataAsString();
  var book = JSON.parse(text || "{}");
  if (!book || book.schemaVersion !== 1 || !book.orders) {
    book = { schemaVersion: 1, lines: [], orders: {}, lastWriteId: "" };
  }
  if (!Array.isArray(book.lines)) book.lines = [];
  return book;
}

function writeBook_(book) {
  findFile_().setContent(JSON.stringify(book, null, 2));
}

function findFile_() {
  var folder = DriveApp.getFolderById(FOLDER_ID);
  var props = PropertiesService.getScriptProperties();
  var stored = props.getProperty("FILE_ID");
  if (stored) {
    try {
      return DriveApp.getFileById(stored);
    } catch (err) {
      stored = "";
    }
  }
  var matches = folder.getFilesByName(FILE_NAME);
  var file = matches.hasNext()
    ? matches.next()
    : folder.createFile(FILE_NAME, JSON.stringify({ schemaVersion: 1, lines: [], orders: {}, lastWriteId: "" }), MimeType.PLAIN_TEXT);
  props.setProperty("FILE_ID", file.getId());
  return file;
}

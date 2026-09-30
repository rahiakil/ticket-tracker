var FILE_NAME = "ticket-tracker-scans.txt";
var FOLDER_ID = "1r679tCaeKA5-y4sXuUEX3xB2GCxx7Xg7";

function doGet(e) {
  var book = readBook_();
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
  writeBook_(book);
  return ContentService.createTextOutput("ok").setMimeType(ContentService.MimeType.TEXT);
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

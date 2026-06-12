var SHEET_NAME = "Attempts";
var HEADERS = ["id", "player_name", "time_ms", "time_display", "created_at"];

function doGet(e) {
  try {
    var action = getAction_(e);

    if (action === "leaderboard") {
      return jsonResponse_({
        ok: true,
        generatedAt: new Date().toISOString(),
        entries: getEntries_()
      });
    }

    return jsonResponse_(
      {
        ok: false,
        error: "פעולה לא מוכרת.",
        code: "UNKNOWN_ACTION"
      },
      400
    );
  } catch (error) {
    return handleError_(error);
  }
}

function doPost(e) {
  try {
    var action = getAction_(e);

    if (action === "login") {
      return handleLogin_(e);
    }

    if (action === "add") {
      return handleAdd_(e);
    }

    if (action === "delete") {
      return handleDelete_(e);
    }

    return jsonResponse_(
      {
        ok: false,
        error: "פעולה לא מוכרת.",
        code: "UNKNOWN_ACTION"
      },
      400
    );
  } catch (error) {
    return handleError_(error);
  }
}

function handleLogin_(e) {
  var password = getParam_(e, "password");
  var adminPassword = getRequiredProperty_("ADMIN_PASSWORD");

  if (!password || password !== adminPassword) {
    return jsonResponse_(
      {
        ok: false,
        error: "סיסמה שגויה.",
        code: "UNAUTHORIZED"
      },
      401
    );
  }

  var deviceToken = Utilities.getUuid();
  storeTrustedDevice_(deviceToken);

  return jsonResponse_({
    ok: true,
    deviceToken: deviceToken
  });
}

function handleAdd_(e) {
  requireTrustedDevice_(e);

  var playerName = normalizeName_(getParam_(e, "playerName"));
  var timeMs = Number(getParam_(e, "timeMs"));
  var timeDisplay = getParam_(e, "timeDisplay");

  if (!playerName) {
    return jsonResponse_(
      {
        ok: false,
        error: "יש להזין שם שחקן.",
        code: "INVALID_NAME"
      },
      400
    );
  }

  if (!timeDisplay || !isFinite(timeMs) || timeMs <= 0) {
    return jsonResponse_(
      {
        ok: false,
        error: "זמן לא תקין.",
        code: "INVALID_TIME"
      },
      400
    );
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var sheet = getSheet_();
    sheet.appendRow([
      Utilities.getUuid(),
      playerName,
      String(timeMs),
      timeDisplay,
      new Date().toISOString()
    ]);
  } finally {
    lock.releaseLock();
  }

  return jsonResponse_({ ok: true });
}

function handleDelete_(e) {
  requireTrustedDevice_(e);

  var id = getParam_(e, "id");

  if (!id) {
    return jsonResponse_(
      {
        ok: false,
        error: "לא נשלח מזהה רשומה.",
        code: "MISSING_ID"
      },
      400
    );
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    var sheet = getSheet_();
    var values = sheet.getDataRange().getValues();

    for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
      if (String(values[rowIndex][0]) === id) {
        sheet.deleteRow(rowIndex + 1);
        return jsonResponse_({ ok: true });
      }
    }
  } finally {
    lock.releaseLock();
  }

  return jsonResponse_(
    {
      ok: false,
      error: "הרשומה לא נמצאה.",
      code: "NOT_FOUND"
    },
    404
  );
}

function getEntries_() {
  var sheet = getSheet_();
  var values = sheet.getDataRange().getValues();
  var entries = [];

  for (var rowIndex = 1; rowIndex < values.length; rowIndex += 1) {
    var row = values[rowIndex];

    if (!row[0]) {
      continue;
    }

    entries.push({
      id: String(row[0]),
      playerName: String(row[1] || ""),
      timeMs: Number(row[2] || 0),
      timeDisplay: String(row[3] || ""),
      createdAt: String(row[4] || "")
    });
  }

  return entries;
}

function getSheet_() {
  var spreadsheetId = getRequiredProperty_("SPREADSHEET_ID");
  var spreadsheet = SpreadsheetApp.openById(spreadsheetId);
  var sheet = spreadsheet.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
  }

  ensureHeaders_(sheet);
  return sheet;
}

function ensureHeaders_(sheet) {
  var existingHeaders = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  var hasHeaders = HEADERS.every(function (header, index) {
    return String(existingHeaders[index] || "") === header;
  });

  if (!hasHeaders) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  }
}

function requireTrustedDevice_(e) {
  var deviceToken = getParam_(e, "deviceToken");
  var trustedDevices = getTrustedDevices_();

  if (!deviceToken || trustedDevices.indexOf(deviceToken) === -1) {
    throw apiError_("הגישה של המכשיר אינה תקפה.", "INVALID_DEVICE", 401);
  }
}

function storeTrustedDevice_(deviceToken) {
  var trustedDevices = getTrustedDevices_();

  if (trustedDevices.indexOf(deviceToken) === -1) {
    trustedDevices.push(deviceToken);
  }

  PropertiesService.getScriptProperties().setProperty(
    "TRUSTED_DEVICES",
    JSON.stringify(trustedDevices)
  );
}

function getTrustedDevices_() {
  var rawValue =
    PropertiesService.getScriptProperties().getProperty("TRUSTED_DEVICES") || "[]";

  try {
    var parsed = JSON.parse(rawValue);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function getAction_(e) {
  var action = getParam_(e, "action");

  if (!action) {
    throw apiError_("חובה לשלוח פעולה.", "MISSING_ACTION", 400);
  }

  return action;
}

function getParam_(e, key) {
  return e && e.parameter ? String(e.parameter[key] || "").trim() : "";
}

function getRequiredProperty_(name) {
  var value = PropertiesService.getScriptProperties().getProperty(name);

  if (!value) {
    throw apiError_("חסר Script Property: " + name, "MISSING_PROPERTY", 500);
  }

  return value;
}

function normalizeName_(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/^\s+|\s+$/g, "");
}

function apiError_(message, code, status) {
  var error = new Error(message);
  error.apiCode = code;
  error.httpStatus = status || 500;
  return error;
}

function handleError_(error) {
  return jsonResponse_(
    {
      ok: false,
      error: error.message || "שגיאה לא צפויה.",
      code: error.apiCode || "INTERNAL_ERROR"
    },
    error.httpStatus || 500
  );
}

function jsonResponse_(payload, status) {
  var output = ContentService.createTextOutput(JSON.stringify(payload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

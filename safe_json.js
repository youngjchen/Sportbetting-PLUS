'use strict';

const fs = require('fs');

function readJsonRequired(file, validate, label) {
  const name = label || file;
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`${name} 不存在或無法讀取，拒絕覆寫舊資料：${e.message}`);
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${name} JSON 損壞，拒絕覆寫舊資料：${e.message}`);
  }
  if (validate && !validate(value)) {
    throw new Error(`${name} 結構異常，拒絕覆寫舊資料`);
  }
  return value;
}

function readFirstJsonRequired(files, validate, label) {
  const found = files.find((file) => fs.existsSync(file));
  if (!found) {
    throw new Error(`${label || files[0]} 不存在，拒絕建立可能不完整的新資料`);
  }
  return readJsonRequired(found, validate, label || found);
}

module.exports = { readJsonRequired, readFirstJsonRequired };

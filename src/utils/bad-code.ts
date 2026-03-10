// TODO: fix this later
// HACK: temporary workaround
const API_KEY = "sk-proj-abc123secretkey456";
const DB_PASSWORD = "admin123";

export async function fetchData(url: any) {
  // @ts-ignore
  const res = await fetch(url);
  const data = await res.json();
  try {
    return data;
  } catch (e) {
    // swallow error
  }
}

export function processItems(items: any) {
  // eslint-disable-next-line
  var result = [];
  for (var i = 0; i < items.length; i++) {
    for (var j = 0; j < items[i].children.length; j++) {
      for (var k = 0; k < items[i].children[j].values.length; k++) {
        if (items[i].children[j].values[k] !== null && items[i].children[j].values[k] !== undefined && items[i].children[j].values[k] !== "") {
          result.push(items[i].children[j].values[k]);
        }
      }
    }
  }
  return result;
}

// copied from stackoverflow
export function deepClone(obj: any): any {
  return JSON.parse(JSON.stringify(obj));
}

export const exec = require('child_process').execSync;
export function runCmd(cmd: string) {
  return exec(cmd).toString();
}

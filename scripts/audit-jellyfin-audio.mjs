import fs from 'node:fs/promises';

const env = Object.fromEntries((await fs.readFile('.env.jellyfin.local', 'utf8')).split(/\r?\n/).flatMap((line) => {
  const m = line.match(/^\s*([^#=]+)=(.*)$/);
  return m ? [[m[1].trim(), m[2].trim().replace(/^"|"$/g, '')]] : [];
}));
const base = env.JELLYFIN_URL;
const headers = { Authorization: `MediaBrowser Token="${env.JELLYFIN_API_KEY}"` };
const users = await (await fetch(`${base}/Users`, { headers })).json();
const userId = users[0]?.Id;
const catalog = await (await fetch(`${base}/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Fields=Name,Path&Limit=10000`, { headers })).json();

async function check(item) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(`${base}/Items/${item.Id}/PlaybackInfo?UserId=${userId}`, { headers, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const streams = data.MediaSources?.flatMap((source) => source.MediaStreams ?? []) ?? [];
    const audio = streams.filter((stream) => stream.Type === 'Audio');
    return { name: item.Name, path: item.Path, audio: audio.length, codecs: [...new Set(audio.map((stream) => stream.Codec).filter(Boolean))] };
  } catch (error) {
    return { name: item.Name, path: item.Path, audio: null, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

const results = [];
for (let i = 0; i < catalog.Items.length; i += 12) {
  results.push(...await Promise.all(catalog.Items.slice(i, i + 12).map(check)));
}
const report = { checkedAt: new Date().toISOString(), checked: results.length, withAudio: results.filter((row) => row.audio > 0).length, needsReview: results.filter((row) => row.audio === 0 || row.audio === null) };
console.log(JSON.stringify(report, null, 2));

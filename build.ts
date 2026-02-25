/**
 * Static site build script.
 * Processes all WutheringData and outputs static JSON files + index.html
 * that can be hosted anywhere (GitHub Pages, Cloudflare Pages, etc.)
 *
 * Usage: bun run build.ts
 * Output: dist/
 */

import { mkdir } from "node:fs/promises";
import { Database } from "bun:sqlite";

const DATA_ROOT = "../WutheringData";
const DATA_CONFIG_ROOT = `${DATA_ROOT}/ConfigDB`;
const DATA_TEXTMAP_ROOT = `${DATA_ROOT}/TextMap/en`;
const OUT_DIR = "./dist";

// --- Data Loading (same as server.ts) ---

async function loadTextMap(): Promise<Record<string, string>> {
	const [a, b] = await Promise.all([
		Bun.file(`${DATA_TEXTMAP_ROOT}/MultiText.json`).json(),
		Bun.file(`${DATA_TEXTMAP_ROOT}/MultiText_1sthalf.json`).json(),
	]);
	return Object.assign({}, a, b);
}

async function loadJson<T = any>(filename: string): Promise<T[]> {
	return Bun.file(`${DATA_CONFIG_ROOT}/${filename}`).json();
}

console.log("Loading data...");
const [textMap, questsRaw, questNodesRaw, flowStatesRaw, speakersRaw] =
	await Promise.all([
		loadTextMap(),
		loadJson<{ QuestId: number; Data: string }>("QuestData.json"),
		loadJson<{ Key: string; Data: string }>("QuestNodeData.json"),
		loadJson<{ StateKey: string; Id: number; Actions: string }>("FlowState.json"),
		loadJson<{ Id: number; Name: number }>("Speaker.json"),
	]);

function t(key: string | number): string {
	return textMap[key] ?? String(key);
}

// --- Build Indexes ---

const speakerMap = new Map<number, string>();
for (const sp of speakersRaw) {
	const name = textMap[`Speaker_${sp.Id}_Name`];
	if (name) speakerMap.set(sp.Id, name);
}

const flowStateMap = new Map<string, any[]>();
for (const fs of flowStatesRaw) {
	try {
		flowStateMap.set(fs.StateKey, JSON.parse(fs.Actions));
	} catch {}
}

interface QuestInfo {
	id: number;
	name: string;
	description: string;
	type: string;
	typeId: number;
	chapterName: string;
	chapterNum: string;
	sectionNum: string;
	actName: string;
	chapterId: number;
	key: string;
}

const quests: QuestInfo[] = [];
const questMap = new Map<number, QuestInfo>();

for (const raw of questsRaw) {
	const data = JSON.parse(raw.Data);
	const name = textMap[data.TidName];
	if (!name) continue;

	const info: QuestInfo = {
		id: data.Id,
		name,
		description: t(data.TidDesc),
		type: t(`QuestType_${data.Type}_QuestTypeName`),
		typeId: data.Type,
		chapterName: t(`QuestChapter_${data.ChapterId}_ChapterName`),
		chapterNum: t(`QuestChapter_${data.ChapterId}_ChapterNum`),
		sectionNum: t(`QuestChapter_${data.ChapterId}_SectionNum`),
		actName: t(`QuestChapter_${data.ChapterId}_ActName`),
		chapterId: data.ChapterId ?? 0,
		key: data.Key,
	};
	quests.push(info);
	questMap.set(info.id, info);
}

const questTypes = [...new Set(quests.map((q) => q.type))]

// Quest chain
const questPrevMap = new Map<number, number[]>();
const questNextMap = new Map<number, number[]>();

for (const raw of questsRaw) {
	const data = JSON.parse(raw.Data);
	const conditions = data.ProvideType?.Conditions ?? [];
	for (const cond of conditions) {
		if (cond.Type === "PreQuest" && cond.PreQuest) {
			if (!questPrevMap.has(data.Id)) questPrevMap.set(data.Id, []);
			questPrevMap.get(data.Id)!.push(cond.PreQuest);
			if (!questNextMap.has(cond.PreQuest)) questNextMap.set(cond.PreQuest, []);
			questNextMap.get(cond.PreQuest)!.push(data.Id);
		}
	}
}

function getQuestChainLinks(questId: number) {
	const prevIds = questPrevMap.get(questId) ?? [];
	const nextIds = questNextMap.get(questId) ?? [];
	const toLink = (id: number) => {
		const q = questMap.get(id);
		return q ? { id: q.id, name: q.name, type: q.type } : { id, name: null, type: null };
	};
	return {
		prev: prevIds.map(toLink).filter((l) => l.name),
		next: nextIds.map(toLink).filter((l) => l.name),
	};
}

// QuestNode index
const questNodeIndex = new Map<number, any[]>();
for (const raw of questNodesRaw) {
	const underscoreIdx = raw.Key.indexOf("_");
	const questId = Number(raw.Key.substring(0, underscoreIdx));
	if (!questNodeIndex.has(questId)) questNodeIndex.set(questId, []);
	questNodeIndex.get(questId)!.push(JSON.parse(raw.Data));
}

console.log(
	`Loaded: ${quests.length} quests, ${questNodesRaw.length} nodes, ${flowStatesRaw.length} flow states, ${speakersRaw.length} speakers`
);

// --- Dialog Extraction (same as server.ts) ---

type DialogItem =
	| { kind: "talk"; speaker: string; text: string; whoId: number; options?: { text: string }[] }
	| { kind: "centerText"; text: string }
	| { kind: "cutscene"; videoName: string }
	| { kind: "narration"; text: string };

interface DialogGroup {
	stepLabel: string;
	nodeId: number;
	nodeDesc: string;
	items: DialogItem[];
}

function extractItemsFromActions(actions: any[]): DialogItem[] {
	const items: DialogItem[] = [];
	for (const action of actions) {
		if (action.Name === "PlayMovie") {
			items.push({ kind: "cutscene", videoName: action.Params?.VideoName ?? "unknown" });
			continue;
		}
		if (action.Name === "ShowCenterText") {
			const text = action.Params?.TidText ? t(action.Params.TidText) : "";
			if (text) items.push({ kind: "centerText", text });
			continue;
		}
		if (action.Name !== "ShowTalk") continue;
		const talkItems = action.Params?.TalkItems;
		if (!Array.isArray(talkItems)) continue;
		for (const item of talkItems) {
			const type = item.Type ?? "Talk";
			if (type === "NoTextItem" || type === "QTE") continue;
			if (type === "CenterText") {
				const text = item.TidTalk ? t(item.TidTalk) : "";
				if (text) items.push({ kind: "centerText", text });
				continue;
			}
			let speaker = item.WhoId != null ? (speakerMap.get(item.WhoId) ?? `Unknown (${item.WhoId})`) : "";
			if (speaker.includes("{PlayerName}")) speaker = "Rover";
			const text = item.TidTalk ? t(item.TidTalk) : "";
			if (!text) continue;
			const line: DialogItem = { kind: speaker ? "talk" : "narration", speaker, text, whoId: item.WhoId };
			if (item.Options?.length) {
				(line as any).options = item.Options.map((opt: any) => ({
					text: t(opt.TidTalkOption),
				}));
			}
			items.push(line);
		}
	}
	return items;
}

function getDialogGroups(questId: number): DialogGroup[] {
	const nodes = questNodeIndex.get(questId);
	if (!nodes) return [];
	const playFlowNodes = nodes
		.filter((n: any) => n.Type === "ChildQuest" && n.Condition?.Type === "PlayFlow")
	const groups: DialogGroup[] = [];
	for (const node of playFlowNodes) {
		const flow = node.Condition.Flow;
		if (!flow) continue;
		const stateKey = `${flow.FlowListName}_${flow.FlowId}_${flow.StateId}`;
		const actions = flowStateMap.get(stateKey);
		if (!actions) continue;
		const items = extractItemsFromActions(actions);
		if (items.length === 0) continue;
		const resolvedTip = node.TidTip && textMap[node.TidTip] && !textMap[node.TidTip].startsWith("Quest_")
			? textMap[node.TidTip] : "";
		const firstTalk = items.find((i) => i.kind === "talk") as Extract<DialogItem, { kind: "talk" }> | undefined;
		const firstSpeaker = firstTalk ? `${firstTalk.speaker}: "${firstTalk.text.slice(0, 60)}..."` : "";
		const stepLabel = resolvedTip || node.Desc || firstSpeaker || `Step ${node.Id}`;
		groups.push({ stepLabel, nodeId: node.Id, nodeDesc: node.Desc ?? "", items });
	}
	return groups;
}

// --- Write Static Files ---

console.log("Writing static files...");

await mkdir(`${OUT_DIR}/data/quests`, { recursive: true });

// quest-types.json
await Bun.write(`${OUT_DIR}/data/quest-types.json`, JSON.stringify(questTypes));

// quests.json — full index with chain links baked in
const questIndex = quests.map((q) => ({
	...q,
	chain: getQuestChainLinks(q.id),
}));
await Bun.write(`${OUT_DIR}/data/quests.json`, JSON.stringify(questIndex));

// Per-quest detail files
let dialogCount = 0;
for (const q of quests) {
	const dialog = getDialogGroups(q.id);
	// Only write a detail file if there's dialog (saves space)
	if (dialog.length > 0) {
		await Bun.write(`${OUT_DIR}/data/quests/${q.id}.json`, JSON.stringify({ dialog }));
		dialogCount++;
	}
}

// --- Word Cloud Static Data (from quests.db) ---

console.log("Generating word cloud data from quests.db...");

const db = new Database("./quests.db", { readonly: true });

const STOP_WORDS = new Set([
	"i", "me", "my", "myself", "we", "our", "ours", "ourselves", "you", "your", "yours",
	"yourself", "yourselves", "he", "him", "his", "himself", "she", "her", "hers", "herself",
	"it", "its", "itself", "they", "them", "their", "theirs", "themselves", "what", "which",
	"who", "whom", "this", "that", "these", "those", "am", "is", "are", "was", "were", "be",
	"been", "being", "have", "has", "had", "having", "do", "does", "did", "doing", "a", "an",
	"the", "and", "but", "if", "or", "because", "as", "until", "while", "of", "at", "by",
	"for", "with", "about", "against", "between", "through", "during", "before", "after",
	"above", "below", "to", "from", "up", "down", "in", "out", "on", "off", "over", "under",
	"again", "further", "then", "once", "here", "there", "when", "where", "why", "how", "all",
	"both", "each", "few", "more", "most", "other", "some", "such", "no", "nor", "not", "only",
	"own", "same", "so", "than", "too", "very", "s", "t", "can", "will", "just", "don", "don't",
	"should", "now", "d", "ll", "m", "o", "re", "ve", "y", "ain", "aren", "couldn", "didn",
	"doesn", "hadn", "hasn", "haven", "isn", "ma", "mightn", "mustn", "needn", "shan", "shouldn",
	"wasn", "weren", "won", "wouldn", "let", "us", "go", "get", "got", "would", "could", "also",
	"still", "much", "well", "back", "even", "come", "like", "know", "think", "make", "right",
	"want", "need", "say", "tell", "see", "look", "one", "way", "may", "might", "shall",
	"i'm", "it's", "that's", "what's", "there's", "here's", "he's", "she's", "who's", "how's",
	"where's", "when's", "why's", "let's", "won't", "can't", "couldn't", "wouldn't",
	"shouldn't", "didn't", "doesn't", "don't", "isn't", "aren't", "wasn't", "weren't",
	"hasn't", "haven't", "hadn't", "mustn't", "needn't", "shan't", "won't", "they're",
	"we're", "you're", "we've", "you've", "they've", "we'll", "you'll", "they'll",
	"he'll", "she'll", "it'll", "we'd", "you'd", "they'd", "he'd", "she'd", "it'd",
	"that'll", "who'll", "what'll", "there'll", "here'll",
]);

// speakers.json
const speakers = db.prepare(
	"SELECT speaker_name, count(*) as line_count FROM dialog_lines WHERE speaker_name != '' GROUP BY speaker_name ORDER BY line_count DESC"
).all() as { speaker_name: string; line_count: number }[];

await mkdir(`${OUT_DIR}/data/speakers`, { recursive: true });
await Bun.write(`${OUT_DIR}/data/speakers.json`, JSON.stringify(speakers));

// Per-speaker: words + lines
const stmtLines = db.prepare(
	"SELECT dl.text, q.name as quest_name, q.id as quest_id FROM dialog_lines dl JOIN quests q ON q.id = dl.quest_id WHERE dl.speaker_name = ? ORDER BY dl.quest_id, dl.sort_order"
);

for (const { speaker_name } of speakers) {
	const lines = stmtLines.all(speaker_name) as { text: string; quest_name: string; quest_id: number }[];

	// Word frequencies (same logic as server.ts)
	const freq = new Map<string, number>();
	for (const { text } of lines) {
		const words = text.toLowerCase().replace(/[^a-z'-]/g, " ").split(/\s+/);
		for (const w of words) {
			if (w.length < 2 || STOP_WORDS.has(w)) continue;
			freq.set(w, (freq.get(w) ?? 0) + 1);
		}
	}
	const words = [...freq.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5000)
		.map(([word, count]) => ({ word, count }));

	const safeName = encodeURIComponent(speaker_name);
	await Bun.write(
		`${OUT_DIR}/data/speakers/${safeName}.json`,
		JSON.stringify({ words, lines: lines.map(l => ({ text: l.text, quest_name: l.quest_name, quest_id: l.quest_id })) })
	);
}

db.close();

console.log(`  ${OUT_DIR}/data/speakers.json — ${speakers.length} speakers`);
console.log(`  ${OUT_DIR}/data/speakers/*.json — per-speaker word + line data`);

// Copy HTML pages
const htmlSource = await Bun.file("./public/index-static.html").text();
await Bun.write(`${OUT_DIR}/index.html`, htmlSource);
const wordcloudSource = await Bun.file("./public/wordcloud-static.html").text();
await Bun.write(`${OUT_DIR}/wordcloud.html`, wordcloudSource);

// Summary
const indexSize = new Blob([JSON.stringify(questIndex)]).size;
console.log(`Done!`);
console.log(`  ${OUT_DIR}/data/quests.json — ${quests.length} quests (${(indexSize / 1024).toFixed(0)}KB)`);
console.log(`  ${OUT_DIR}/data/quests/*.json — ${dialogCount} quest detail files`);
console.log(`  ${OUT_DIR}/index.html`);

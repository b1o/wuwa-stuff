import { Database } from "bun:sqlite";

const DATA_ROOT = "../WutheringData";
const DATA_CONFIG_ROOT = `${DATA_ROOT}/ConfigDB`;
const DATA_TEXTMAP_ROOT = `${DATA_ROOT}/TextMap/en`;
const DB_PATH = "./quests.db";

// --- Data Loading (same as server.ts) ---

async function loadTextMap(): Promise<Record<string, string>> {
	const [a, b] = await Promise.all([
		Bun.file(`${DATA_TEXTMAP_ROOT}/MultiText.json`).json(),
		Bun.file(`${DATA_TEXTMAP_ROOT}/MultiText_1sthalf.json`).json(),
	]);
	return { ...a, ...b };
}

async function loadJson<T = any>(filename: string): Promise<T[]> {
	return Bun.file(`${DATA_CONFIG_ROOT}/${filename}`).json();
}

console.log("Loading data...");
const [textMap, questsRaw, questNodesRaw, flowStatesRaw, speakersRaw] = await Promise.all([
	loadTextMap(),
	loadJson<{ QuestId: number; Data: string }>("QuestData.json"),
	loadJson<{ Key: string; Data: string }>("QuestNodeData.json"),
	loadJson<{ StateKey: string; Id: number; Actions: string }>("FlowState.json"),
	loadJson<{ Id: number; Name: number }>("Speaker.json"),
]);

function t(key: string | number): string {
	return textMap[String(key)] ?? String(key);
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

const questDataParsed = questsRaw.map((raw) => JSON.parse(raw.Data));

interface QuestInfo {
	id: number;
	name: string;
	chapterName: string;
	actName: string;
	chapterId: number;
}

const quests: QuestInfo[] = [];

for (const data of questDataParsed) {
	const name = textMap[data.TidName];
	if (name) {
		const chapterName = t(`QuestChapter_${data.ChapterId}_ChapterName`);
		const actName = t(`QuestChapter_${data.ChapterId}_ActName`);
		quests.push({
			id: data.Id,
			name,
			chapterName: chapterName.startsWith("QuestChapter_") ? "" : chapterName,
			actName: actName.startsWith("QuestChapter_") ? "" : actName,
			chapterId: data.ChapterId ?? 0,
		});
	}
}

// QuestNode index
const questNodeIndex = new Map<number, any[]>();
for (const raw of questNodesRaw) {
	const underscoreIdx = raw.Key.indexOf("_");
	const questId = Number(raw.Key.substring(0, underscoreIdx));
	if (!questNodeIndex.has(questId)) questNodeIndex.set(questId, []);
	questNodeIndex.get(questId)!.push(JSON.parse(raw.Data));
}

console.log(`Loaded: ${quests.length} quests, ${questNodesRaw.length} nodes, ${flowStatesRaw.length} flow states, ${speakersRaw.length} speakers`);

// --- Dialog Extraction (same as server.ts, but flattened) ---

interface FlatDialogLine {
	speaker_name: string;
	speaker_id: number | null;
	text: string;
}

function extractFlatDialogLines(questId: number): FlatDialogLine[] {
	const nodes = questNodeIndex.get(questId);
	if (!nodes) return [];

	const lines: FlatDialogLine[] = [];

	for (const node of nodes) {
		if (node.Type !== "ChildQuest" || node.Condition?.Type !== "PlayFlow") continue;
		const flow = node.Condition.Flow;
		if (!flow) continue;

		const stateKey = `${flow.FlowListName}_${flow.FlowId}_${flow.StateId}`;
		const actions = flowStateMap.get(stateKey);
		if (!actions) continue;

		for (const action of actions) {
			if (action.Name !== "ShowTalk") continue;
			const talkItems = action.Params?.TalkItems;
			if (!Array.isArray(talkItems)) continue;

			for (const item of talkItems) {
				const type = item.Type ?? "Talk";
				if (type === "NoTextItem" || type === "QTE" || type === "CenterText") continue;

				const text = item.TidTalk ? t(item.TidTalk) : "";
				if (!text) continue;

				let speakerName = item.WhoId != null ? (speakerMap.get(item.WhoId) ?? "") : "";
				if (speakerName.includes("{PlayerName}")) speakerName = "Rover";
				lines.push({
					speaker_name: speakerName,
					speaker_id: item.WhoId ?? null,
					text,
				});
			}
		}
	}

	return lines;
}

// --- Build SQLite DB ---

console.log("Building SQLite database...");

// Remove existing DB
try {
	const file = Bun.file(DB_PATH);
	if (await file.exists()) {
		const { unlinkSync } = await import("node:fs");
		unlinkSync(DB_PATH);
	}
} catch {}

const db = new Database(DB_PATH);

db.run(`CREATE TABLE quests (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	group_name TEXT NOT NULL,
	chapter_id INTEGER NOT NULL
)`);

db.run(`CREATE TABLE dialog_lines (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	quest_id INTEGER NOT NULL REFERENCES quests(id),
	speaker_name TEXT NOT NULL,
	speaker_id INTEGER,
	text TEXT NOT NULL,
	sort_order INTEGER NOT NULL
)`);

// Insert in a transaction for performance
const insertQuest = db.prepare("INSERT INTO quests (id, name, group_name, chapter_id) VALUES (?, ?, ?, ?)");
const insertLine = db.prepare("INSERT INTO dialog_lines (quest_id, speaker_name, speaker_id, text, sort_order) VALUES (?, ?, ?, ?, ?)");

const transaction = db.transaction(() => {
	let questCount = 0;
	let lineCount = 0;

	for (const quest of quests) {
		// Build group name from chapter + act
		let groupName = "";
		if (quest.chapterName && quest.actName) {
			groupName = `${quest.chapterName} - ${quest.actName}`;
		} else if (quest.chapterName) {
			groupName = quest.chapterName;
		} else if (quest.actName) {
			groupName = quest.actName;
		}

		insertQuest.run(quest.id, quest.name, groupName, quest.chapterId);
		questCount++;

		const lines = extractFlatDialogLines(quest.id);
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			insertLine.run(quest.id, line.speaker_name, line.speaker_id, line.text, i);
			lineCount++;
		}
	}

	return { questCount, lineCount };
});

const { questCount, lineCount } = transaction();

db.run("CREATE INDEX idx_dialog_quest ON dialog_lines(quest_id)");
db.run("CREATE INDEX idx_dialog_speaker ON dialog_lines(speaker_id)");

db.close();

console.log(`Done! Created ${DB_PATH}`);
console.log(`  ${questCount} quests`);
console.log(`  ${lineCount} dialog lines`);

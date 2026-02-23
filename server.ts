import { Hono } from "hono";
import { serveStatic } from "hono/bun";

const DATA_ROOT = "../WutheringData";
const DATA_CONFIG_ROOT = `${DATA_ROOT}/ConfigDB`;
const DATA_TEXTMAP_ROOT = `${DATA_ROOT}/TextMap/en`;

// --- Data Loading ---

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

// Speaker map: WhoId -> display name
const speakerMap = new Map<number, string>();
for (const sp of speakersRaw) {
	const name = textMap[`Speaker_${sp.Id}_Name`];
	if (name) speakerMap.set(sp.Id, name);
}

// FlowState map: StateKey -> parsed actions array
const flowStateMap = new Map<string, any[]>();
for (const fs of flowStatesRaw) {
	try {
		flowStateMap.set(fs.StateKey, JSON.parse(fs.Actions));
	} catch {}
}

// Parse quests
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

// Quest types for filtering
const questTypes = [...new Set(quests.map((q) => q.type))].sort();

// Quest chain: prev/next from PreQuest conditions
const questPrevMap = new Map<number, number[]>(); // questId -> prerequisite quest ids
const questNextMap = new Map<number, number[]>(); // questId -> quests that require this

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

// QuestNode index: questId -> parsed nodes
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

// --- Dialog Extraction ---

// Types for dialog items within a group
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

			// Skip non-text items
			if (type === "NoTextItem" || type === "QTE") continue;

			if (type === "CenterText") {
				const text = item.TidTalk ? t(item.TidTalk) : "";
				if (text) items.push({ kind: "centerText", text });
				continue;
			}

			// Talk, Option, SystemOption, PhoneMessage, undefined — treat as dialog
			const speaker = item.WhoId != null ? (speakerMap.get(item.WhoId) ?? `Unknown (${item.WhoId})`) : "";
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

	// Get all ChildQuest nodes with PlayFlow condition, sorted by Id for execution order
	const playFlowNodes = nodes
		.filter((n: any) => n.Type === "ChildQuest" && n.Condition?.Type === "PlayFlow")
		.sort((a: any, b: any) => a.Id - b.Id);

	const groups: DialogGroup[] = [];

	for (const node of playFlowNodes) {
		const flow = node.Condition.Flow;
		if (!flow) continue;

		const stateKey = `${flow.FlowListName}_${flow.FlowId}_${flow.StateId}`;
		const actions = flowStateMap.get(stateKey);
		if (!actions) continue;

		const items = extractItemsFromActions(actions);
		if (items.length === 0) continue;

		// Build a meaningful label: resolved tip > node desc > first speaker line > generic
		const resolvedTip = node.TidTip && textMap[node.TidTip] && !textMap[node.TidTip].startsWith("Quest_")
			? textMap[node.TidTip] : "";
		const firstTalk = items.find((i) => i.kind === "talk") as Extract<DialogItem, { kind: "talk" }> | undefined;
		const firstSpeaker = firstTalk ? `${firstTalk.speaker}: "${firstTalk.text.slice(0, 60)}..."` : "";
		const stepLabel = resolvedTip || node.Desc || firstSpeaker || `Step ${node.Id}`;

		groups.push({
			stepLabel,
			nodeId: node.Id,
			nodeDesc: node.Desc ?? "",
			items,
		});
	}

	return groups;
}

// --- Hono App ---

const app = new Hono();

// API routes
app.get("/api/quests", (c) => {
	const q = (c.req.query("q") ?? "").toLowerCase();
	const type = c.req.query("type") ?? "";
	const page = Math.max(1, Number(c.req.query("page") ?? "1"));
	const pageSize = 50;

	let filtered = quests;

	if (q) {
		filtered = filtered.filter((quest) => quest.name.toLowerCase().includes(q));
	}
	if (type) {
		filtered = filtered.filter((quest) => quest.type === type);
	}

	const total = filtered.length;
	const results = filtered.slice((page - 1) * pageSize, page * pageSize);

	return c.json({ results, total, page, pageSize });
});

app.get("/api/quests/:id", (c) => {
	const id = Number(c.req.param("id"));
	const quest = questMap.get(id);
	if (!quest) return c.json({ error: "Quest not found" }, 404);

	const dialog = getDialogGroups(id);
	const chain = getQuestChainLinks(id);
	return c.json({ quest, dialog, chain });
});

app.get("/api/quest-types", (c) => {
	return c.json(questTypes);
});

// Static files
app.use("/*", serveStatic({ root: "./public" }));

export default {
	port: 3000,
	fetch: app.fetch,
};

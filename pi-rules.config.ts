import { anyOf, command, defineConfig } from "./extensions/pi-rules/api";

export default defineConfig({
	rules: [
		{
			match: anyOf(command("grep"), command("grep *")),
			action: "deny",
			reason: "Use rg instead of grep.",
		},
		{
			match: anyOf(command("find"), command("find *")),
			action: "deny",
			reason: "Use fd instead of find.",
		},
		{
			match: anyOf(command("fd /"), command("fd * /")),
			action: "deny",
			reason: "Search a narrower path; do not search the entire filesystem root (/).",
		},
	],
});

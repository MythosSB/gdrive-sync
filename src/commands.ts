import { Notice, normalizePath } from "obsidian";
import type GDriveSyncPlugin from "./main";
import { PlanModal } from "./plan-modal";
import { SyncEngine } from "./sync";

// Registra los comandos relacionados con la sincronización.
export function registerSyncCommands(plugin: GDriveSyncPlugin): void {
	const engine = new SyncEngine(
		plugin.app,
		plugin.drive,
		() => plugin.settings.driveFolderName || plugin.app.vault.getName(),
		() => {
			const dir = plugin.manifest.dir;
			if (!dir) throw new Error("No se encontró la carpeta del plugin");
			return normalizePath(`${dir}/sync-state.json`);
		}
	);

	plugin.addCommand({
		id: "sync-dry-run",
		name: "Sync: preview changes (dry run)",
		callback: async () => {
			try {
				new Notice("Analizando cambios...");
				const plan = await engine.buildPlan();
				new PlanModal(plugin.app, plan).open();
			} catch (error) {
				console.error(error);
				new Notice(error instanceof Error ? error.message : String(error));
			}
		},
	});
}
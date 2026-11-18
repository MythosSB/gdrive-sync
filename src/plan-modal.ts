import { App, Modal } from "obsidian";
import type { SyncAction } from "./planner";
import type { PlanResult } from "./sync";

const LABELS: Record<SyncAction["type"], string> = {
	upload: "↑ Subir a Drive",
	download: "↓ Descargar de Drive",
	"delete-local": "✕ Borrar aquí (ya no está en Drive)",
	"delete-remote": "✕ Mandar a la papelera de Drive",
	conflict: "⚠ Conflicto (se conservarán ambas versiones)",
	record: "= Idéntico en ambos lados",
	forget: "· Ya no existe en ningún lado",
};

// Ventana que muestra qué haría la sincronización, sin hacer nada todavía.
export class PlanModal extends Modal {
	constructor(app: App, private plan: PlanResult) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Vista previa de la sincronización" });

		contentEl.createEl("p", {
			text: `Archivos en la bóveda: ${this.plan.local.size} · Archivos en Drive: ${this.plan.remote.size}`,
		});

		const real = this.plan.actions.filter(
			(a) => a.type !== "record" && a.type !== "forget"
		);
		const bookkeeping = this.plan.actions.length - real.length;

		if (real.length === 0) {
			contentEl.createEl("p", { text: "✅ Todo está sincronizado. No hay nada que hacer." });
		} else {
			const counts = new Map<string, number>();
			for (const action of real) {
				counts.set(action.type, (counts.get(action.type) ?? 0) + 1);
			}
			const summary = contentEl.createEl("ul");
			for (const [type, count] of counts) {
				summary.createEl("li", {
					text: `${LABELS[type as SyncAction["type"]]}: ${count}`,
				});
			}

			contentEl.createEl("h3", { text: "Detalle" });
			const list = contentEl.createEl("ul");
			for (const action of real.slice(0, 200)) {
				list.createEl("li", { text: `${LABELS[action.type]} — ${action.path}` });
			}
			if (real.length > 200) {
				contentEl.createEl("p", { text: `... y ${real.length - 200} más.` });
			}
		}

		if (bookkeeping > 0) {
			contentEl.createEl("p", {
				text: `Archivos ya idénticos o desaparecidos que solo se registrarán: ${bookkeeping}`,
			});
		}
				if (this.plan.skippedLarge.length > 0) {
			contentEl.createEl("p", {
				text:
					`⚠ Se omitieron ${this.plan.skippedLarge.length} archivo(s) por superar ` +
					"el tamaño máximo (se puede cambiar en los ajustes):",
			});
			const big = contentEl.createEl("ul");
			for (const path of this.plan.skippedLarge.slice(0, 20)) {
				big.createEl("li", { text: path });
			}
		}
		for (const warning of this.plan.warnings) {
			contentEl.createEl("p", { text: `⚠ ${warning}` });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
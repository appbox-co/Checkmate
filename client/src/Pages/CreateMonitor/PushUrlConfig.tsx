import { useState } from "react";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useTheme } from "@mui/material/styles";
import { useTranslation } from "react-i18next";
import { ConfigBox } from "@/Components/design-elements";
import { Button, Dialog, TextField } from "@/Components/inputs";
import { usePost } from "@/Hooks/UseApi";
import { useToast } from "@/Hooks/UseToast";
import { LAYOUT } from "@/Utils/Theme/constants";
import { runtimeConfig } from "@/Utils/runtimeConfig";
import type { Monitor } from "@/Types/Monitor";

// The dashboard may be reached through a tunnel or private address, so a
// configured public origin takes precedence over the current one.
const getPushUrl = (token: string): string => {
	const base = (runtimeConfig.pushBaseUrl || window.location.origin).replace(/\/+$/, "");
	return `${base}/api/v1/push/${token}`;
};

interface PushUrlConfigProps {
	monitor: Monitor;
	onRegenerated: () => void;
}

export const PushUrlConfig = ({ monitor, onRegenerated }: PushUrlConfigProps) => {
	const theme = useTheme();
	const { t } = useTranslation();
	const { toastSuccess, toastError } = useToast();
	const { post, loading } = usePost<undefined, Monitor>();
	const [confirmOpen, setConfirmOpen] = useState(false);
	const url = monitor.pushToken ? getPushUrl(monitor.pushToken) : "";

	const copy = async () => {
		try {
			await navigator.clipboard.writeText(url);
			toastSuccess(t("pages.createMonitor.form.push.copied"));
		} catch {
			toastError(t("pages.createMonitor.form.push.copyFailed"));
		}
	};

	const regenerate = async () => {
		const result = await post(`/monitors/${monitor.id}/push-token`, undefined);
		setConfirmOpen(false);
		if (result?.success) onRegenerated();
	};

	const lastPush = monitor.lastPushAt
		? t("pages.createMonitor.form.push.lastPush", {
				date: new Date(monitor.lastPushAt).toLocaleString(),
			})
		: t("pages.createMonitor.form.push.noPush");

	return (
		<ConfigBox
			title={t("pages.createMonitor.form.push.title")}
			subtitle={t("pages.createMonitor.form.push.description")}
			rightContent={
				<Stack spacing={theme.spacing(LAYOUT.MD)}>
					<TextField
						fieldLabel={t("pages.createMonitor.form.push.urlLabel")}
						value={url}
						slotProps={{ input: { readOnly: true } }}
						onFocus={(event) => event.target.select()}
					/>
					<Typography color={theme.palette.text.secondary}>{lastPush}</Typography>
					<Stack
						direction="row"
						spacing={theme.spacing(LAYOUT.SM)}
					>
						<Button
							type="button"
							variant="contained"
							color="primary"
							disabled={!url}
							onClick={copy}
						>
							{t("pages.createMonitor.form.push.copy")}
						</Button>
						<Button
							type="button"
							variant="outlined"
							color="secondary"
							onClick={() => setConfirmOpen(true)}
						>
							{t("pages.createMonitor.form.push.regenerate")}
						</Button>
					</Stack>
					<Dialog
						open={confirmOpen}
						title={t("pages.createMonitor.form.push.regenerateTitle")}
						content={t("pages.createMonitor.form.push.regenerateDescription")}
						onConfirm={regenerate}
						onCancel={() => setConfirmOpen(false)}
						loading={loading}
					/>
				</Stack>
			}
		/>
	);
};

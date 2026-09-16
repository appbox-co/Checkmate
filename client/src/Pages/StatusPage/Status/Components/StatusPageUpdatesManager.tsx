import { useTheme } from "@mui/material/styles";
import { useState } from "react";
import {
	Alert,
	Box,
	Checkbox,
	FormControlLabel,
	MenuItem,
	Stack,
	TextField,
	Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { Button, Dialog } from "@/Components/inputs";
import { useDelete, usePost, usePut } from "@/Hooks/UseApi";
import {
	STATUS_UPDATE_STATES,
	type StatusPage,
	type StatusPageUpdate,
	type StatusPageUpdateInput,
} from "@/Types/StatusPage";
import { sortStatusUpdates, formatStatusDate } from "@/Utils/statusPageUpdates";

interface Props {
	statusPage: StatusPage;
	onChange: () => Promise<unknown>;
}
const emptyUpdate: StatusPageUpdateInput = {
	title: "",
	body: "",
	status: "announcement",
	pinned: false,
};

export const StatusPageUpdatesManager = ({ statusPage, onChange }: Props) => {
	const { t, i18n } = useTranslation();
	const theme = useTheme();
	const [open, setOpen] = useState(false);
	const [editing, setEditing] = useState<StatusPageUpdate | "new" | null>(null);
	const [draft, setDraft] = useState<StatusPageUpdateInput>(emptyUpdate);
	const [deleteTarget, setDeleteTarget] = useState<StatusPageUpdate | null>(null);
	const [invalid, setInvalid] = useState(false);
	const { post, loading: posting } = usePost<StatusPageUpdateInput, StatusPage>();
	const { put, loading: putting } = usePut<StatusPageUpdateInput, StatusPage>();
	const { deleteFn, loading: deleting } = useDelete<StatusPage>();
	const busy = posting || putting || deleting;
	const endpoint = `/status-page/${statusPage.id}/updates`;
	const updates = sortStatusUpdates(statusPage.updates ?? []);
	const startEditing = (update: StatusPageUpdate | "new") => {
		setEditing(update);
		setInvalid(false);
		setDraft(
			update === "new"
				? { ...emptyUpdate }
				: {
						title: update.title,
						body: update.body,
						status: update.status,
						pinned: update.pinned,
					}
		);
	};
	const save = async () => {
		if (busy || editing === null) return;
		if (!draft.title.trim() || !draft.body.trim()) {
			setInvalid(true);
			return;
		}
		const body = { ...draft, title: draft.title.trim(), body: draft.body.trim() };
		const result =
			editing === "new"
				? await post(endpoint, body)
				: await put(`${endpoint}/${editing.id}`, body);
		if (result?.success) {
			setEditing(null);
			await onChange();
		}
	};
	const togglePin = async (update: StatusPageUpdate) => {
		const result = await put(`${endpoint}/${update.id}`, {
			title: update.title,
			body: update.body,
			status: update.status,
			pinned: !update.pinned,
		});
		if (result?.success) await onChange();
	};
	const remove = async () => {
		if (!deleteTarget || busy) return;
		const result = await deleteFn(`${endpoint}/${deleteTarget.id}`);
		if (result?.success) {
			setDeleteTarget(null);
			await onChange();
		}
	};
	return (
		<>
			<Button
				variant="outlined"
				onClick={() => setOpen(true)}
				sx={{ alignSelf: "flex-start", mb: 3 }}
			>
				{t("pages.statusPages.communications.manage")}
			</Button>
			<Dialog
				open={open}
				title={t("pages.statusPages.communications.manage")}
				fullWidth
				maxWidth="md"
				cancelText={t("pages.statusPages.communications.close")}
				onCancel={() => {
					if (!busy) {
						setOpen(false);
						setEditing(null);
					}
				}}
			>
				<Stack gap={3}>
					<Alert severity="info">
						{t(
							statusPage.isPublished
								? "pages.statusPages.communications.publicHint"
								: "pages.statusPages.communications.unpublishedHint"
						)}
					</Alert>
					{editing !== null ? (
						<Stack gap={3}>
							<TextField
								label={t("pages.statusPages.communications.title")}
								value={draft.title}
								onChange={(event) => setDraft({ ...draft, title: event.target.value })}
								inputProps={{ maxLength: 160 }}
								required
								fullWidth
								disabled={busy}
								error={invalid && !draft.title.trim()}
								helperText={
									invalid && !draft.title.trim()
										? t("pages.statusPages.communications.required")
										: undefined
								}
							/>
							<TextField
								label={t("pages.statusPages.communications.message")}
								value={draft.body}
								onChange={(event) => setDraft({ ...draft, body: event.target.value })}
								inputProps={{ maxLength: 5000 }}
								multiline
								minRows={5}
								fullWidth
								required
								disabled={busy}
								error={invalid && !draft.body.trim()}
								helperText={
									invalid && !draft.body.trim()
										? t("pages.statusPages.communications.required")
										: t("pages.statusPages.communications.plainText")
								}
							/>
							<TextField
								select
								label={t("pages.statusPages.communications.updateStatus")}
								value={draft.status}
								onChange={(event) =>
									setDraft({
										...draft,
										status: event.target.value as StatusPageUpdateInput["status"],
									})
								}
								disabled={busy}
							>
								{STATUS_UPDATE_STATES.map((status) => (
									<MenuItem
										key={status}
										value={status}
									>
										{t(`pages.statusPages.communications.status.${status}`)}
									</MenuItem>
								))}
							</TextField>
							<FormControlLabel
								control={
									<Checkbox
										checked={draft.pinned}
										onChange={(event) =>
											setDraft({ ...draft, pinned: event.target.checked })
										}
										disabled={busy}
									/>
								}
								label={t("pages.statusPages.communications.pinLabel")}
							/>
							<Stack
								direction="row"
								gap={2}
								justifyContent="flex-end"
							>
								<Button
									disabled={busy}
									onClick={() => setEditing(null)}
								>
									{t("common.buttons.cancel")}
								</Button>
								<Button
									variant="contained"
									loading={posting || putting}
									onClick={save}
								>
									{t(
										editing === "new" && statusPage.isPublished
											? "pages.statusPages.communications.publish"
											: "common.buttons.save"
									)}
								</Button>
							</Stack>
						</Stack>
					) : (
						<>
							<Stack
								direction="row"
								justifyContent="space-between"
								alignItems="center"
								gap={2}
							>
								<Typography color={theme.palette.text.secondary}>
									{t("pages.statusPages.communications.count", { count: updates.length })}
								</Typography>
								<Button
									variant="contained"
									disabled={busy || updates.length >= 200}
									onClick={() => startEditing("new")}
								>
									{t("pages.statusPages.communications.new")}
								</Button>
							</Stack>
							{updates.length >= 200 && (
								<Alert severity="info">
									{t("pages.statusPages.communications.limit")}
								</Alert>
							)}
							{!updates.length && (
								<Typography color={theme.palette.text.secondary}>
									{t("pages.statusPages.communications.empty")}
								</Typography>
							)}
							{updates.map((update) => (
								<Box
									key={update.id}
									p={3}
									border={1}
									borderRadius={1}
									sx={{ borderColor: "divider", overflowWrap: "anywhere" }}
								>
									<Typography variant="h3">{update.title}</Typography>
									<Typography color={theme.palette.text.secondary}>
										{t(`pages.statusPages.communications.status.${update.status}`)}
										{update.pinned
											? ` · ${t("pages.statusPages.communications.pinned")}`
											: ""}
									</Typography>
									<Typography
										my={2}
										sx={{ whiteSpace: "pre-wrap" }}
									>
										{update.body}
									</Typography>
									<Typography
										variant="caption"
										color={theme.palette.text.secondary}
									>
										{update.author}
										{" · "}
										{formatStatusDate(
											update.createdAt,
											statusPage.timezone,
											i18n.language
										)}
									</Typography>
									<Stack
										direction="row"
										gap={1}
										flexWrap="wrap"
										mt={2}
									>
										<Button
											disabled={busy}
											onClick={() => startEditing(update)}
										>
											{t("pages.statusPages.communications.edit")}
										</Button>
										<Button
											disabled={busy}
											onClick={() => togglePin(update)}
										>
											{t(
												update.pinned
													? "pages.statusPages.communications.unpin"
													: "pages.statusPages.communications.pin"
											)}
										</Button>
										<Button
											disabled={busy}
											color="error"
											onClick={() => setDeleteTarget(update)}
										>
											{t("common.buttons.delete")}
										</Button>
									</Stack>
								</Box>
							))}
						</>
					)}
				</Stack>
			</Dialog>
			<Dialog
				open={Boolean(deleteTarget)}
				title={t("pages.statusPages.communications.deleteTitle")}
				content={t("pages.statusPages.communications.deleteHint", {
					title: deleteTarget?.title,
				})}
				confirmColor="error"
				confirmText={t("common.buttons.delete")}
				loading={deleting}
				onConfirm={remove}
				onCancel={() => {
					if (!busy) setDeleteTarget(null);
				}}
			/>
		</>
	);
};

import Box from "@mui/material/Box";
import { monoFirstChar } from "@/Pages/StatusPage/Status/themes/shared/overallStatus";
import type { SlotProps } from "@/Pages/StatusPage/Status/themes/shared/BaseStatusPage";
import type { ModernStyles } from "@/Pages/StatusPage/Status/themes/modern/styles";

export const ModernHeader = ({
	statusPage,
	logoSrc,
	styles,
}: SlotProps<ModernStyles>) => {
	const isAppbox = statusPage.url === "appbox";
	const logo = (
		<Box
			component="img"
			src={logoSrc ?? undefined}
			alt={statusPage.companyName}
			sx={styles.logoImg}
		/>
	);
	return (
		<Box sx={styles.brand}>
			{logoSrc ? (
				isAppbox ? (
					<Box
						component="a"
						href="https://www.appbox.co"
						display="inline-flex"
						color="inherit"
						sx={{
							"&:focus-visible": { outline: "2px solid currentColor", outlineOffset: 4 },
						}}
					>
						{logo}
					</Box>
				) : (
					logo
				)
			) : (
				<Box sx={styles.logoGrad}>{monoFirstChar(statusPage.companyName)}</Box>
			)}
			{(!isAppbox || !logoSrc) && statusPage.companyName}
		</Box>
	);
};

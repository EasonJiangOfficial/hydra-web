import { createCn } from "cn/config";

/**
 * Class merging that knows Hydra's custom type sizes (theme.css `--text-*`). The stock `cn`
 * treats `text-label` as a color, so `cn("text-label text-ink-3")` dropped `text-label`.
 */
export const cn = createCn({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: ["hero", "figure", "figure-s", "title", "section", "tab", "body", "label", "tag", "wordmark", "micro"],
        },
      ],
    },
  },
});

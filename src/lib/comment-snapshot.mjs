export async function extractCommentSnapshot(page) {
  return page.evaluate(() => {
    const root =
      document.querySelector('[data-codex-comment-scroll="true"]') || document.body;

    const normalize = (value = "") => value.replace(/\s+/g, " ").trim();
    const metaPattern =
      /(分钟前|小时前|天前|昨天|前天|刚刚|IP属地|发布于|\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}|赞)/;
    const replyThreadPattern = /(条回复|收起)/;
    const controlPattern = /^(回复|发送|收起)$/;
    const pureNumberPattern = /^\d+$/;
    const avatarSelector = 'img, [class*="avatar"], [class*="Avatar"]';
    const xBandTolerance = 12;
    const replyIndentMinDelta = 16;

    const splitLines = (value = "") =>
      value
        .split(/\n+/)
        .map((line) => normalize(line))
        .filter(Boolean);

    const normalizeNameLine = (value = "") =>
      normalize(value).replace(/\s+/g, "").replace(/作者$/, "");

    const isNoiseLine = (line) => controlPattern.test(line) || pureNumberPattern.test(line);

    const parseStructuredEntry = (rawLines, order) => {
      const lines = rawLines.filter((line) => !isNoiseLine(line));
      if (lines.length < 2) {
        return null;
      }

      let cursor = 0;
      let username = normalizeNameLine(lines[cursor]);
      cursor += 1;

      while (cursor < lines.length && lines[cursor] === "作者") {
        cursor += 1;
      }

      if (!username && cursor < lines.length) {
        username = normalizeNameLine(lines[cursor]);
        cursor += 1;
      }

      const commentSegments = [];
      while (cursor < lines.length) {
        const line = lines[cursor];
        if (line === "作者") {
          cursor += 1;
          continue;
        }

        if (replyThreadPattern.test(line)) {
          break;
        }

        if (!metaPattern.test(line)) {
          commentSegments.push(line);
        }
        cursor += 1;
      }

      const commentText = normalize(commentSegments.join(" "));
      if (!username || !commentText) {
        return null;
      }

      const consumedLineCount = cursor;
      const publishText = normalize(
        lines
          .slice(1, consumedLineCount)
          .filter((line) => line !== "作者" && metaPattern.test(line))
          .join(" ")
      );

      return {
        username,
        commentText,
        publishText,
        consumedLineCount,
        order,
        signature: [username, commentText, publishText].map(normalize).join("|")
      };
    };

    const extractStructuredEntryFromBlock = (block, order) => {
      if (!(block instanceof HTMLElement)) {
        return null;
      }

      const candidates = Array.from(block.querySelectorAll("div, span, p"))
        .filter((node) => node instanceof HTMLElement)
        .map((node) => ({
          node,
          text: normalize(node.textContent || "")
        }))
        .filter((item) => item.text)
        .slice(0, 120);
      if (candidates.length === 0) {
        return null;
      }

      const lineSet = new Set(splitLines(block.innerText || ""));
      const textRows = Array.from(lineSet).slice(0, 40);

      const usernameText =
        textRows.find((line) => {
          if (!line || line.length > 40) {
            return false;
          }
          if (metaPattern.test(line) || replyThreadPattern.test(line) || controlPattern.test(line)) {
            return false;
          }
          return true;
        }) || "";

      const publishText =
        textRows.find((line) => metaPattern.test(line) && !controlPattern.test(line)) || "";

      let commentText =
        textRows.find((line) => {
          if (!line || line === usernameText || line === publishText) {
            return false;
          }
          if (metaPattern.test(line) || replyThreadPattern.test(line) || controlPattern.test(line)) {
            return false;
          }
          return true;
        }) || "";

      if (!commentText) {
        const imageLikeNode = candidates.find(({ node }) => node.querySelector("img"));
        if (imageLikeNode) {
          commentText = "[image]";
        }
      }

      const username = normalizeNameLine(usernameText);
      if (!username || !commentText) {
        return null;
      }

      return {
        entry: {
          username,
          commentText,
          publishText,
          consumedLineCount: 0,
          order,
          signature: [username, commentText, publishText]
            .map(normalize)
            .join("|")
        }
      };
    };

    for (const marked of root.querySelectorAll("[data-codex-comment-block]")) {
      marked.removeAttribute("data-codex-comment-block");
    }

    const collectBlocks = () => {
      const explicitBlocks = Array.from(root.querySelectorAll("[comment-item]"));
      if (explicitBlocks.length > 0) {
        return explicitBlocks;
      }

      const replyButtons = Array.from(root.querySelectorAll("button, div, span")).filter(
        (node) => normalize(node.textContent || "") === "回复"
      );

      const blocks = [];
      const seen = new Set();

      const findBlock = (node) => {
        let current = node.parentElement;
        while (current && current !== root) {
          if (!(current instanceof HTMLElement)) {
            return null;
          }

          const text = normalize(current.innerText || "");
          const replyButtonCount = Array.from(current.querySelectorAll("button, div, span")).filter(
            (child) => normalize(child.textContent || "") === "回复"
          ).length;
          const avatarCount = current.querySelectorAll(
            'img, [class*="avatar"], [class*="Avatar"]'
          ).length;

          if (
            avatarCount >= 1 &&
            avatarCount <= 12 &&
            replyButtonCount >= 1 &&
            replyButtonCount <= 20 &&
            text.length <= 4000
          ) {
            return current;
          }

          current = current.parentElement;
        }

        return null;
      };

      for (const replyButton of replyButtons) {
        const block = findBlock(replyButton);
        if (!block || seen.has(block)) {
          continue;
        }

        seen.add(block);
        blocks.push(block);
      }

      return blocks;
    };

    const rawBlocks = collectBlocks()
      .map((block, domIndex) => {
        if (block instanceof HTMLElement) {
          block.setAttribute("data-codex-comment-block", String(domIndex));
        }

        const rawLines = splitLines(block.innerText || "");

        if (rawLines.length === 0) {
          return null;
        }

        const rect = block instanceof HTMLElement ? block.getBoundingClientRect() : null;
        const structuredBlock = extractStructuredEntryFromBlock(block, domIndex);
        if (structuredBlock) {
          return {
            domIndex,
            left: Number.isFinite(rect?.left) ? rect.left : 0,
            top: Number.isFinite(rect?.top) ? rect.top : domIndex,
            entry: structuredBlock.entry
          };
        }

        const mainEntry = parseStructuredEntry(rawLines, domIndex);
        if (!mainEntry) {
          return null;
        }

        return {
          domIndex,
          left: Number.isFinite(rect?.left) ? rect.left : 0,
          top: Number.isFinite(rect?.top) ? rect.top : domIndex,
          entry: mainEntry
        };
      })
      .filter(Boolean);

    const resolveReplyIndentThreshold = (blocks) => {
      const leftPositions = blocks
        .map((block) => block.left)
        .filter((value) => Number.isFinite(value))
        .sort((left, right) => left - right);

      if (leftPositions.length === 0) {
        return Number.POSITIVE_INFINITY;
      }

      const bands = [];
      for (const left of leftPositions) {
        const lastBand = bands[bands.length - 1];
        if (!lastBand || Math.abs(left - lastBand.max) > xBandTolerance) {
          bands.push({
            min: left,
            max: left,
            values: [left]
          });
          continue;
        }

        lastBand.max = left;
        lastBand.values.push(left);
      }

      if (bands.length < 2) {
        return Number.POSITIVE_INFINITY;
      }

      const mainBand = bands[0];
      const mainAnchor =
        mainBand.values.reduce((sum, value) => sum + value, 0) / mainBand.values.length;
      const replyBand = bands.find(
        (band, index) => index > 0 && band.min - mainAnchor >= replyIndentMinDelta
      );

      if (!replyBand) {
        return Number.POSITIVE_INFINITY;
      }

      return (mainAnchor + replyBand.min) / 2;
    };

    const replyIndentThreshold = resolveReplyIndentThreshold(rawBlocks);
    const orderedBlocks = rawBlocks
      .slice()
      .sort((left, right) =>
        left.top === right.top ? left.left - right.left : left.top - right.top
      );

    const comments = [];
    let currentMainComment = null;

    const flushCurrentMainComment = () => {
      if (!currentMainComment) {
        return;
      }

      comments.push({
        domIndex: currentMainComment.domIndex,
        username: currentMainComment.username,
        commentText: currentMainComment.commentText,
        publishText: currentMainComment.publishText,
        signature: currentMainComment.signature,
        order: currentMainComment.order
      });

      currentMainComment = null;
    };

    for (const block of orderedBlocks) {
      const entry = block.entry;
      if (!entry?.signature) {
        continue;
      }

      const isReplyBlock =
        Number.isFinite(replyIndentThreshold) && block.left >= replyIndentThreshold;

      if (!isReplyBlock || !currentMainComment) {
        flushCurrentMainComment();
        currentMainComment = {
          domIndex: block.domIndex,
          username: entry.username,
          commentText: entry.commentText,
          publishText: entry.publishText,
          signature: entry.signature,
          order: block.domIndex
        };
        continue;
      }
    }

    flushCurrentMainComment();
    return comments;
  });
}

export function addCommentsFromSnapshot(commentsBySignature, snapshot) {
  let additions = 0;

  for (const comment of snapshot) {
    if (!comment.signature) {
      continue;
    }

    const existingComment = commentsBySignature.get(comment.signature);
    if (!existingComment) {
      commentsBySignature.set(comment.signature, comment);
      additions += 1;
      continue;
    }

    commentsBySignature.set(comment.signature, {
      ...existingComment,
      ...comment,
      publishText:
        comment.publishText && comment.publishText.length >= (existingComment.publishText ?? "").length
          ? comment.publishText
          : existingComment.publishText,
      order:
        typeof existingComment.order === "number" && typeof comment.order === "number"
          ? Math.min(existingComment.order, comment.order)
          : typeof existingComment.order === "number"
            ? existingComment.order
            : comment.order
    });
  }

  return additions;
}

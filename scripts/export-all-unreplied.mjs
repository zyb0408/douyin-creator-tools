import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

const PROJECT_DIR = "/Users/yingbin/Desktop/hermes_workspace/dev/douyin-creator-tools";
const OUTPUT_DIR = path.join(PROJECT_DIR, "comments-output");

function printHelp() {
  console.log(`
Usage:
  node ./scripts/export-all-unreplied.mjs
  node ./scripts/export-all-unreplied.mjs --latest 5
  node ./scripts/export-all-unreplied.mjs --offset 5 --latest 5

Options:
  --latest <n>   Only process the latest N works from list-works.json
  --offset <n>   Skip the first N works before applying --latest
  --help         Print this help
  `);
}

function toPositiveInteger(value, flagName) {
  const num = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${flagName} requires a positive integer, got: ${value}`);
  }
  return num;
}

function toNonNegativeInteger(value, flagName) {
  const num = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(num) || num < 0) {
    throw new Error(`${flagName} requires a non-negative integer, got: ${value}`);
  }
  return num;
}

function parseArgs(argv) {
  const args = {
    latest: 0,
    offset: 0,
    help: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--latest":
        args.latest = toPositiveInteger(argv[index + 1], "--latest");
        index += 1;
        break;
      case "--offset":
        args.offset = toNonNegativeInteger(argv[index + 1], "--offset");
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

// 读取作品列表
const listWorksPath = path.join(OUTPUT_DIR, "list-works.json");
const listWorks = JSON.parse(fs.readFileSync(listWorksPath, "utf-8"));

const allWorks = Array.isArray(listWorks.works) ? listWorks.works : [];
const works = allWorks.slice(
  args.offset,
  args.latest > 0 ? args.offset + args.latest : undefined
);

console.log(
  `作品总数 ${allWorks.length} 个，本次处理 ${works.length} 个（offset=${args.offset}, latest=${
    args.latest || "all"
  }）`
);
console.log(`开始逐个导出未回复评论...`);

const allComments = [];

for (let i = 0; i < works.length; i++) {
  const work = works[i];
  const title = work.title;
  
  console.log(`[${i + 1}/${works.length}] 导出: ${title}`);
  
  await new Promise((resolve, reject) => {
    execFile(
      "node",
      ["./src/export-douyin-comments.mjs", title],
      {
        cwd: PROJECT_DIR,
        timeout: 120000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024
      },
      (err, stdout, stderr) => {
        if (err) {
          console.error(`[ERROR] ${title}: ${err.message}`);
          resolve(false);
          return;
        }
        if (stdout) console.log(stdout);
        if (stderr) console.error(stderr);
        resolve(true);
      }
    );
  });
  
  // 读取导出的结果
  const unrepliedPath = path.join(OUTPUT_DIR, "unreplied-comments.json");
  if (fs.existsSync(unrepliedPath)) {
    const unreplied = JSON.parse(fs.readFileSync(unrepliedPath, "utf-8"));
    
    if (unreplied.count > 0 && unreplied.comments && unreplied.comments.length > 0) {
      console.log(`  -> 找到 ${unreplied.count} 条未回复评论`);
      
      for (const comment of unreplied.comments) {
        allComments.push({
          selectedWork: unreplied.selectedWork,
          username: comment.username,
          commentText: comment.commentText,
          replyMessage: "",
          history: comment.history || []
        });
      }
    } else {
      console.log(`  -> 无未回复评论`);
    }
  }
}

console.log(`\n===== 总结 =====`);
console.log(`共导出 ${allComments.length} 条未回复评论`);

// 保存合并结果
const mergedOutput = {
  totalWorks: works.length,
  sourceWorks: allWorks.length,
  offset: args.offset,
  latest: args.latest || null,
  totalUnrepliedComments: allComments.length,
  comments: allComments
};

const mergedPath = path.join(OUTPUT_DIR, "all-unreplied-comments.json");
fs.writeFileSync(mergedPath, JSON.stringify(mergedOutput, null, 2), "utf-8");
console.log(`已保存到: ${mergedPath}`);

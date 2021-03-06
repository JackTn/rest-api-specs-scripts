// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License. See License.txt in the project root for license information.

import * as tsUtils from './ts-utils'
import * as momentOfTruthUtils from './momentOfTruthUtils'
import * as utils from './utils'
import * as gitHubPost from './postToGitHub'

import * as fs from 'fs'
import * as path from 'path'

import * as format from "@azure/swagger-validation-common"

import {getFile, getLine, composeLintResult ,MutableIssue } from "./momentOfTruthUtils"

const githubTemplate = (title: unknown, contact_message: unknown, file_summaries: unknown) =>
  `# AutoRest linter results for ${title}\n${contact_message}\n\n${file_summaries}`;

const fileSummaryHeader = (file_name: unknown, file_href: unknown) => `## Config file: [${file_name}](${file_href})\n`;
const fileSummaryNewTemplate = (issue_type: string, issue_count: unknown, issue_table: unknown) =>
  `<details><summary><h3 style="display: inline"><a name="${issue_type.replace(/\s/g, "-")}s"></a>${iconFor(issue_type)} ${issue_count} new ${pluralize(issue_type, issue_count)}</h3></summary><br>\n\n${issue_table}\n</details>`;
const fileSummaryExistingTemplate = (issue_type: string, issue_count: unknown, issue_table: unknown) =>
  `<details><summary>${iconFor(issue_type)} ${issue_count} existing ${pluralize(issue_type, issue_count)}</summary><br>\n\n${issue_table}\n</details>\n\n`;

const potentialNewWarningErrorSummaryHeader = `
| | Rule | Location | Message |
|-|------|----------|---------|
`;

const potentialNewWarningErrorSummaryMarkdown = (
  count: unknown,
  warning_error_id: unknown,
  warning_error_code: unknown,
  warning_error_file: string,
  warning_error_line: unknown,
  warning_error_message: unknown
) =>
  `|${count}|[${warning_error_id} - ${warning_error_code}](https://github.com/Azure/azure-rest-api-specs/blob/master/documentation/openapi-authoring-automated-guidelines.md#${warning_error_id})|` +
  `[${shortName(warning_error_file)}:${warning_error_line}](${utils.blobHref(warning_error_file)}#L${warning_error_line} "${warning_error_file}")|` +
  `${warning_error_message}|\n`;

const potentialNewWarningErrorSummaryPlain = (
  _count: unknown,
  warning_error_id: unknown,
  warning_error_code: unknown,
  warning_error_file: unknown,
  warning_error_line: unknown,
  warning_error_message: unknown
) =>
  `${warning_error_id} - ${warning_error_code}\n` +
  `${warning_error_message}\n` +
  `  at ${warning_error_file}:${warning_error_line}\n\n`;

const sdkContactMessage = "These errors are reported by the SDK team's validation tools, reach out to [ADX Swagger Reviewers](mailto:adxsr@microsoft.com) directly for any questions or concerns.";
const armContactMessage = "These errors are reported by the ARM team's validation tools, reach out to [ARM RP API Review](mailto:armrpapireview@microsoft.com) directly for any questions or concerns.";
let sdkFileSummaries = '', armFileSummaries = '';

function compareJsonRef(beforeJsonRef: string, afterJsonRef: string) {
  beforeJsonRef = beforeJsonRef.replace(/.*\.json:\d+:\d+/, '')
  afterJsonRef = afterJsonRef.replace(/.*\.json:\d+:\d+/, '')

  return (beforeJsonRef == afterJsonRef);
}

function formatSummaryLine(issueType: string, count: number) {
  let line = `&nbsp;&nbsp;&nbsp;${iconFor(issueType, count)}&nbsp;&nbsp;&nbsp;`;
  if (count > 0) {
    line += '[';
  }
  line += `**${count}** new ${pluralize(issueType, count)}`;
  if (count > 0) {
    line += `](#user-content-${issueType.replace(/\s/g, "-")}s)`;
  }
  line += "\n\n";
  return line;
}

function getSummaryBlock(summaryTitle: unknown, fileSummaries: unknown, contactMessage: unknown) {
  return githubTemplate(
    summaryTitle,
    contactMessage,
    fileSummaries !== "" ? fileSummaries : `**There were no files containing ${summaryTitle}.**`
  );
}

function compareBeforeAfterArrays(
  afterArray: readonly momentOfTruthUtils.Issue[],
  beforeArray: readonly momentOfTruthUtils.Issue[],
  existingArray: unknown[],
  newArray: unknown[]
) {
  afterArray.forEach(afterValue => {
    let errorFound = false;
    beforeArray.some(beforeValue => {
      if(
        beforeValue.type               == afterValue.type &&
        beforeValue.code               == afterValue.code &&
        beforeValue.message            == afterValue.message &&
        beforeValue.id                 == afterValue.id &&
        beforeValue.validationCategory == afterValue.validationCategory &&
        beforeValue.providerNamespace  == afterValue.providerNamespace &&
        beforeValue.resourceType       == afterValue.resourceType &&
        beforeValue.sources.length     == afterValue.sources.length &&
        compareJsonRef(beforeValue.jsonref, afterValue.jsonref)
      ) {
        errorFound = true;
        return true
      }
    });
    if(errorFound) {
      existingArray.push(afterValue);
    } else {
      newArray.push(afterValue);
    }
  });
}

function iconFor(type: string, num: unknown = undefined) {
  if (num === 0) {
    return ':white_check_mark:';
  }

  if (type.toLowerCase().includes('error')) {
    return ':x:';
  } else {
    return ':warning:';
  }
}

function pluralize(word: unknown, num: unknown) {
  return num !== 1 ? `${word}s` : word;
}

function shortName(filePath: string) {
  return `${path.basename(path.dirname(filePath))}/&#8203;<strong>${path.basename(filePath)}</strong>`;
}


type Formatter = (
  count: unknown,
  id: unknown,
  code: unknown,
  filePath: string,
  lineNumber: unknown,
  message: unknown
) => string

function getFileSummaryTable(issues: MutableIssue[], header: unknown, formatter: Formatter) {
  let potentialNewIssues = header;

  issues.sort((a, b) => {
    if (!a.filePath) {
      a.filePath = getFile(a.jsonref) || "";
      a.lineNumber = getLine(a.jsonref) || 1;
    }

    if (!b.filePath) {
      b.filePath = getFile(b.jsonref) || "";
      b.lineNumber = getLine(b.jsonref) || 1;
    }

    const comparison = a.filePath.localeCompare(b.filePath);
    if (comparison !== 0) {
      return comparison;
    } else if (a.lineNumber !== b.lineNumber) {
      return a.lineNumber - b.lineNumber;
    } else {
      return a.id.localeCompare(b.id);
    }
  });

  issues.forEach(function (issue, count) {
    if (!issue.filePath) {
      issue.filePath = getFile(issue.jsonref) || "";
      issue.lineNumber = getLine(issue.jsonref) || 1;
    }

    potentialNewIssues += formatter(
      count + 1,
      issue.id,
      issue.code,
      issue.filePath,
      issue.lineNumber,
      issue.message
    );
  });

  return potentialNewIssues;
}

function getFileSummary(
  issueType: unknown,
  fileName: unknown,
  existingWarnings: MutableIssue[],
  existingErrors: MutableIssue[],
  newWarnings: MutableIssue[],
  newErrors: MutableIssue[]
) {
  let fileSummary = "";

  if (newErrors.length > 0) {
    fileSummary += fileSummaryNewTemplate(
      `${issueType} Error`,
      newErrors.length,
      getFileSummaryTable(newErrors, potentialNewWarningErrorSummaryHeader, potentialNewWarningErrorSummaryMarkdown)
    );
  }

  if (existingErrors.length > 0) {
    fileSummary += fileSummaryExistingTemplate(`${issueType} Error`, existingErrors.length, getFileSummaryTable(existingErrors, potentialNewWarningErrorSummaryHeader, potentialNewWarningErrorSummaryMarkdown));
  }

  if (fileSummary !== "") {
    fileSummary += "<br>\n\n";
  }

  if (newWarnings.length > 0) {
    fileSummary += fileSummaryNewTemplate(`${issueType} Warning`, newWarnings.length, getFileSummaryTable(newWarnings, potentialNewWarningErrorSummaryHeader, potentialNewWarningErrorSummaryMarkdown));
  }

  if (existingWarnings.length > 0) {
    fileSummary += fileSummaryExistingTemplate(`${issueType} Warning`, existingWarnings.length, getFileSummaryTable(existingWarnings, potentialNewWarningErrorSummaryHeader, potentialNewWarningErrorSummaryMarkdown));
  }

  if (fileSummary !== "") {
    return fileSummaryHeader(fileName, utils.blobHref(fileName)) + fileSummary;
  } else {
    return "";
  }
}

function emailLink(title: unknown, addr: unknown, subject = "", body = "") {
  let link = `<a href='mailto:${addr}`;
  let sep = "?";
  if (subject && subject.length > 0) {
    link += `${sep}subject=${encodeURIComponent(subject)}`;
    sep = "&";
  }
  if (body && body.length > 0) {
    link += `${sep}body=${encodeURIComponent(body)}`;
  }
  link += `'>${title}</a>`;

  return link;
}

export function postProcessing() {
  const pullRequestNumber = utils.getPullRequestNumber();
  const targetBranch = utils.getTargetBranch();
  const filename = `${pullRequestNumber}.json`;
  const logFilepath = path.join(momentOfTruthUtils.getLogDir(), filename);

  let data = undefined;
  let jsonData: momentOfTruthUtils.FinalResult|undefined = undefined;
  try {
    data = fs.readFileSync(logFilepath, 'utf8');
    jsonData = JSON.parse(data);
  } catch (e) {
    console.log(`Failed to read diff results from file ${logFilepath}`);
    console.log("File content:");
    console.log(data);
    process.exit(1)
  }

  function getOutputMessages(
    newSDKErrorsCount: number,
    newARMErrorsCount: number,
    newSDKWarningsCount: number,
    newARMWarningsCount: number
  ) {
    const totalNewErrors = newSDKErrorsCount + newARMErrorsCount;
    const totalNewWarnings = newSDKWarningsCount + newARMWarningsCount;

    const title = `${totalNewErrors} new ${pluralize('error', totalNewErrors)} / ${totalNewWarnings} new ${pluralize('warning', totalNewWarnings)}`;
    let summary = `Compared to the target branch (**${targetBranch}**), this pull request introduces:\n\n`;
    summary += formatSummaryLine("SDK Error", newSDKErrorsCount);
    summary += formatSummaryLine("ARM Error", newARMErrorsCount);
    summary += formatSummaryLine("SDK Warning", newSDKWarningsCount);
    summary += formatSummaryLine("ARM Warning", newARMWarningsCount);

    return [title, summary];
  }

  const tooManyResults =
    "# Result limit exceeded, check build output\n" +
    "The linter diff produced too many results to display here. Please view the build output to see the results. " +
    "For help with SDK-related validation Errors / Warnings, reach out to [ADX Swagger Reviewers](mailto:adxsr@microsoft.com). " +
    "For help with ARM-related validation Errors / Warnings, reach out to [ARM RP API Review](mailto:armrpapireview@microsoft.com).\n\n" +
    `### [View Build Output](https://travis-ci.org/${process.env.TRAVIS_REPO_SLUG}/jobs/${process.env.TRAVIS_JOB_ID})`;

  const githubFooter =
    `[AutoRest Linter Guidelines](https://github.com/Azure/azure-rest-api-specs/blob/master/documentation/openapi-authoring-automated-guidelines.md) | ` +
    `[AutoRest Linter Issues](https://github.com/Azure/azure-openapi-validator/issues) | ` +
    `Send ${emailLink("feedback", "azure-swag-tooling@microsoft.com", "Feedback | AutoRest Linter Diff Tool")}` +
    `\n\nThanks for your co-operation.`;

  let newSDKErrorsCount = 0, newARMErrorsCount = 0, newSDKWarningsCount = 0, newARMWarningsCount = 0;

  console.log("\n---------- Linter Diff Results ----------\n")

  if (!jsonData) {
    const reportLink = emailLink(
      "report this failure",
      "azure-swag-tooling@microsoft.com",
      "Failure | AutoRest Linter Diff Tool",
      `Please examine the failure in PR https://github.com/${process.env.TRAVIS_REPO_SLUG}/pull/${pullRequestNumber}\r\nThe failing job is https://travis-ci.org/${process.env.TRAVIS_REPO_SLUG}/jobs/${process.env.TRAVIS_JOB_ID}`
    );

    const output = {
      title: "Failed to produce a result",
      summary: `The Linter Diff tool failed to produce a result. Work with your reviewer to examine the lint results manually before merging.\n\nPlease ${reportLink}!`
    };

    console.log("---output");
    console.log(JSON.stringify(output));
    console.log("---");

    return;
  }

  const configFiles = Object.keys(jsonData.files);
  configFiles.sort();

  for (const fileName of configFiles) {
    const beforeErrorsSDKArray: momentOfTruthUtils.Issue[] = []
    const beforeWarningsSDKArray: momentOfTruthUtils.Issue[] = []
    const beforeErrorsARMArray: momentOfTruthUtils.Issue[] = []
    const beforeWarningsARMArray: momentOfTruthUtils.Issue[] = []
    const afterErrorsSDKArray: momentOfTruthUtils.Issue[] = []
    const afterWarningsSDKArray: momentOfTruthUtils.Issue[] = []
    const afterErrorsARMArray: momentOfTruthUtils.Issue[] = []
    const afterWarningsARMArray: momentOfTruthUtils.Issue[] = [];
    const newSDKErrors: MutableIssue[] = []
    const newSDKWarnings: MutableIssue[] = []
    const newARMErrors: MutableIssue[] = []
    const newARMWarnings: MutableIssue[] = []
    const existingSDKErrors: MutableIssue[] = []
    const existingSDKWarnings: MutableIssue[] = []
    const existingARMErrors: MutableIssue[] = []
    const existingARMWarnings: MutableIssue[] = []

    const beforeErrorsAndWarningsArray = tsUtils.asNonUndefined(jsonData.files[fileName]).before;
    beforeErrorsAndWarningsArray.forEach(beforeErrorOrWarning => {
      if(beforeErrorOrWarning.type != undefined && beforeErrorOrWarning.type.toLowerCase() == 'warning'){
        if(beforeErrorOrWarning.validationCategory.toLowerCase() == 'sdkviolation') {
          beforeWarningsSDKArray.push(beforeErrorOrWarning);
         } else if (beforeErrorOrWarning.validationCategory.toLowerCase() !=="rpaasviolation")  {
          beforeWarningsARMArray.push(beforeErrorOrWarning);
        }
      }

      if(beforeErrorOrWarning.type != undefined && beforeErrorOrWarning.type.toLowerCase() == 'error'){
        if(beforeErrorOrWarning.validationCategory.toLowerCase() == 'sdkviolation') {
          beforeErrorsSDKArray.push(beforeErrorOrWarning);
        } else if (beforeErrorOrWarning.validationCategory.toLowerCase() !=="rpaasviolation")  {
          beforeErrorsARMArray.push(beforeErrorOrWarning);
        }
      }
    });

    const afterErrorsAndWarningsArray = tsUtils.asNonUndefined(jsonData.files[fileName]).after;
    afterErrorsAndWarningsArray.forEach(afterErrorOrWarning => {
      if(afterErrorOrWarning.type != undefined && afterErrorOrWarning.type.toLowerCase() == 'warning'){
        if(afterErrorOrWarning.validationCategory.toLowerCase() == 'sdkviolation') {
          afterWarningsSDKArray.push(afterErrorOrWarning);
        } else if (afterErrorOrWarning.validationCategory.toLowerCase() !== "rpaasviolation") {
          afterWarningsARMArray.push(afterErrorOrWarning);
        }
      }

      if(afterErrorOrWarning.type != undefined && afterErrorOrWarning.type.toLowerCase() == 'error'){
        if(afterErrorOrWarning.validationCategory.toLowerCase() == 'sdkviolation') {
          afterErrorsSDKArray.push(afterErrorOrWarning);
        } else if (afterErrorOrWarning.validationCategory.toLowerCase() !== "rpaasviolation") {
          afterErrorsARMArray.push(afterErrorOrWarning);
        }
      }
    });



    compareBeforeAfterArrays(afterErrorsARMArray, beforeErrorsARMArray, existingARMErrors, newARMErrors);
    compareBeforeAfterArrays(afterErrorsSDKArray, beforeErrorsSDKArray, existingSDKErrors, newSDKErrors);
    compareBeforeAfterArrays(afterWarningsARMArray, beforeWarningsARMArray, existingARMWarnings, newARMWarnings);
    compareBeforeAfterArrays(afterWarningsSDKArray, beforeWarningsSDKArray, existingSDKWarnings, newSDKWarnings);

    console.log(`Config file: ${fileName}\n`)
    console.log("SDK Errors/Warnings");
    console.log("===================");
    console.log("Errors:    Before: ", beforeErrorsSDKArray.length, " - After: ", afterErrorsSDKArray.length);
    console.log("Warnings:  Before: ", beforeWarningsSDKArray.length, " - After: ", afterWarningsSDKArray.length);
    console.log("New SDK Errors: ", newSDKErrors.length);
    console.log("New SDK Warnings: ", newSDKWarnings.length);
    console.log("Existing SDK Errors: ", existingSDKErrors.length);
    console.log("Existing SDK Warnings: ", existingSDKWarnings.length);
    console.log();
    console.log("ARM Errors/Warnings");
    console.log("===================");
    console.log("Errors:    Before: ", beforeErrorsARMArray.length, " - After: ", afterErrorsARMArray.length);
    console.log("Warnings:  Before: ", beforeWarningsARMArray.length, " - After: ", afterWarningsARMArray.length);
    console.log("New ARM Errors: ", newARMErrors.length);
    console.log("New ARM Warnings: ", newARMWarnings.length);
    console.log("Existing ARM Errors: ", existingARMErrors.length);
    console.log("Existing ARM Warnings: ", existingARMWarnings.length);
    console.log();

    if (newSDKErrors.length > 0) {
      console.log(`Potential new SDK errors`)
      console.log("========================");
      console.log(getFileSummaryTable(newSDKErrors, "", potentialNewWarningErrorSummaryPlain));
    }
    if (newSDKWarnings.length > 0) {
      console.log(`Potential new SDK warnings`)
      console.log("==========================");
      console.log(getFileSummaryTable(newSDKWarnings, "", potentialNewWarningErrorSummaryPlain));
    }
    if (newARMErrors.length > 0) {
      console.log(`Potential new ARM errors`)
      console.log("========================");
      console.log(getFileSummaryTable(newARMErrors, "", potentialNewWarningErrorSummaryPlain));
    }
    if (newARMWarnings.length > 0) {
      console.log(`Potential new ARM warnings`)
      console.log("==========================");
      console.log(getFileSummaryTable(newARMWarnings, "", potentialNewWarningErrorSummaryPlain));
    }

    console.log("-----------------------------------------\n")

    newSDKErrorsCount += newSDKErrors.length;
    newARMErrorsCount += newARMErrors.length;
    newSDKWarningsCount += newSDKWarnings.length;
    newARMWarningsCount += newARMWarnings.length;

    console.log("-------- Compose Lint Diff Final Result --------\n");
    const pipelineResultData: format.ResultMessageRecord[] = newSDKErrors
    .concat(newARMErrors)
    .concat(newSDKWarnings)
    .concat(newARMWarnings)
    .map(
      (it) => ({
        type: "Result",
        ...composeLintResult(it)
      })
    );
  const pipelineResult: format.MessageLine = pipelineResultData;

  console.log("---------------- Write to pipe.log -------------------");
  console.log(JSON.stringify(pipelineResult));
  fs.appendFileSync("pipe.log", JSON.stringify(pipelineResult) + "\n");
  console.log("---------");

    sdkFileSummaries += getFileSummary("SDK", fileName, existingSDKWarnings, existingSDKErrors, newSDKWarnings, newSDKErrors);
    armFileSummaries += getFileSummary("ARM", fileName, existingARMWarnings, existingARMErrors, newARMWarnings, newARMErrors);
  }

  const sdkSummary = getSummaryBlock("SDK-related validation Errors / Warnings", sdkFileSummaries, sdkContactMessage);
  const armSummary = getSummaryBlock("ARM-related validation Errors / Warnings", armFileSummaries, armContactMessage);
  const text = `${sdkSummary}<br><br>\n\n${armSummary}<br><br>\n\n${githubFooter}`;

  const [title, summary] = getOutputMessages(newSDKErrorsCount, newARMErrorsCount, newSDKWarningsCount, newARMWarningsCount);
  const output = {
    title,
    summary,
    text: text.length <= 65535 ? text : `${tooManyResults}<br><br>\n\n${githubFooter}`
  }

  console.log("---output");
  console.log(JSON.stringify(output, null, 2));
  console.log("---");

  if(process.env.TRAVIS_REPO_SLUG != undefined && process.env.TRAVIS_REPO_SLUG.endsWith("-pr")) {
    let slug = process.env.TRAVIS_REPO_SLUG;
    slug = slug.split("/")[1];
    gitHubPost.postGithubComment("Azure", slug, parseInt(pullRequestNumber), output.text);
  }

  if (newSDKErrorsCount > 0 || newARMErrorsCount > 0) {
    process.exitCode = 1;
  }
}

import * as React from "react";
import {
  BadgeCheckIcon,
  BuildingIcon,
  KeyRoundIcon,
  LaptopIcon,
  MonitorSmartphoneIcon,
  PackageIcon,
  PenToolIcon,
  RefreshCwIcon,
  type LucideIcon,
} from "lucide-react";
import { ActionButton, Field, FieldStack, IconTile, Pill, RadioCards, SheetList, SheetSection, TextInput, FormSheet } from "@/components/kit";
import { DocsIconLink } from "@/components/patterns/DocsIconLink";
import { CodeBox } from "./CodeBox";

export const SELF_SIGNING_GUIDE_URL = "https://github.com/vibtra/guard-oss/blob/main/docs/guide/self-signing.md";
const GUARD_REPO_URL = "https://github.com/vibtra/guard-oss.git";

const TEAM_ID = /^[A-Z0-9]{10}$/;
const BUNDLE_PREFIX = /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PREFIX_MAX = 145;

export interface SigningInputs {
  team: string;
  prefix: string;
  tag: string;
}

type Problems = Partial<Record<keyof SigningInputs, string>>;

export const normalise = (inputs: SigningInputs): SigningInputs => ({
  team: inputs.team.trim().toUpperCase(),
  prefix: inputs.prefix.trim(),
  tag: inputs.tag.trim(),
});

export const problemsOf = (raw: SigningInputs): Problems => {
  const inputs = normalise(raw);
  const problems: Problems = {};
  if (!TEAM_ID.test(inputs.team)) problems.team = "Enter the 10 letters and digits shown as Team ID under Membership details at developer.apple.com.";
  if (!BUNDLE_PREFIX.test(inputs.prefix) || inputs.prefix.length > PREFIX_MAX)
    problems.prefix = `Enter a reverse-DNS name on a domain you own, such as com.acme.guard: letters, digits and hyphens between dots, up to ${PREFIX_MAX} characters.`;
  if (!RELEASE_TAG.test(inputs.tag)) problems.tag = "Enter a Guard release tag, such as guard-v0.2.0: letters, digits, dots, hyphens and underscores.";
  return problems;
};

const quote = (value: string): string => (/^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

export const commandsFor = (raw: SigningInputs, organisation: string): { clone: string; sign: string; zip: string; profile: string } => {
  const { team, prefix, tag } = normalise(raw);
  const folder = tag;
  return {
    clone: `git clone --branch ${quote(tag)} ${GUARD_REPO_URL} ${quote(folder)} && cd ${quote(folder)}`,
    sign: [
      "python3 guard/mac/tools/sign-guard.py",
      `--team ${team}`,
      `--bundle-prefix ${quote(prefix)}`,
      '--key-id "$ASC_KEY_ID" --issuer-id "$ASC_ISSUER_ID" --key-file "$ASC_KEY_FILE"',
      `--tag ${quote(tag)}`,
      `--out ${quote(`../${folder}-signed`)}`,
      `--organization ${quote(organisation)}`,
    ].join(" "),
    zip: `Guard-${tag}-${team}-arm64.zip`,
    profile: `${prefix}.mobileconfig`,
  };
};

interface Need {
  id: string;
  icon: LucideIcon;
  title: string;
  detail: React.ReactNode;
}

const NEEDS: readonly Need[] = [
  {
    id: "membership",
    icon: BuildingIcon,
    title: "A paid Apple Developer Program membership for your organisation",
    detail: "An organisation account, not an individual one. Apple charges a yearly fee.",
  },
  {
    id: "certificate",
    icon: BadgeCheckIcon,
    title: "A Developer ID Application certificate",
    detail:
      "Only your team’s Account Holder can create one. The wizard signs with the certificate and its private key in the signing Mac’s keychain. It does not use Apple’s cloud-managed certificates yet.",
  },
  {
    id: "api-key",
    icon: KeyRoundIcon,
    title: "An App Store Connect API key with the Admin role",
    detail: "You need its key ID, its issuer ID and its .p8 file. Apple lets you download the .p8 file once.",
  },
  {
    id: "mdm",
    icon: MonitorSmartphoneIcon,
    title: "A device-management tool, such as Jamf Pro, Kandji or Microsoft Intune",
    detail: "macOS pre-approves Guard’s network extension only from a profile your device-management server delivers.",
  },
  {
    id: "mac",
    icon: LaptopIcon,
    title: "A Mac with Xcode, Go and xcodegen",
    detail: "Or a macOS runner in GitHub Actions, using the template the guide describes.",
  },
  {
    id: "re-sign",
    icon: RefreshCwIcon,
    title: "A re-sign for every Guard release",
    detail: "Run the wizard again for each new release tag, then give your Macs the new ZIP.",
  },
];

interface Failure {
  id: string;
  problem: string;
  recovery: React.ReactNode;
}

const FAILURES: readonly Failure[] = [
  {
    id: "identity",
    problem: "No Developer ID Application identity for your team",
    recovery: "Ask your Account Holder to create the certificate, then import it with its private key into the signing Mac’s keychain and run the command again.",
  },
  {
    id: "key-team",
    problem: "The API key belongs to another team, or the certificate is not in its account",
    recovery: "Make an API key with the Admin role in the App Store Connect account of the team you entered, then run the command again. Nothing was created.",
  },
  {
    id: "profiles",
    problem: "The provisioning profiles failed the release checks",
    recovery: "Make the two Developer ID profiles by hand as the wizard prints, then run again with --app-profile and --extension-profile.",
  },
  {
    id: "notary",
    problem: "Apple did not accept the notarization",
    recovery: "Read notary-log.json in the output folder. Nothing was shipped. If it names your certificate or signature, fix that and run again with a new --out folder. If it names Guard’s own code, send the log to Vibtra.",
  },
  {
    id: "out",
    problem: "The --out folder already exists, or is inside the checkout",
    recovery: "Pass a new folder outside the checkout with --out. Nothing was overwritten.",
  },
  {
    id: "checkout",
    problem: "This checkout is not at the release tag, or has local changes",
    recovery: "Clone the tag again with the first command, then run the signing command from that folder.",
  },
  {
    id: "approval",
    problem: "Macs still ask people to allow the network extension",
    recovery: "The profile has not reached that Mac. Check that it is scoped to the Mac in your device-management tool and was installed before the app.",
  },
  {
    id: "enrol",
    problem: "An enrol link says it is used or expired",
    recovery: "Make a new link with Enrol laptop. Each link enrols one Mac, once.",
  },
];

type Route = "self" | "vibtra";

function NeedRow({ need }: { need: Need }) {
  return (
    <div className="flex min-w-0 items-start gap-3 px-4 py-3">
      <IconTile icon={need.icon} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-14 font-medium text-pretty text-g-ink">{need.title}</span>
        <span className="text-13 text-pretty text-g-muted">{need.detail}</span>
      </div>
    </div>
  );
}

function FailureRow({ failure }: { failure: Failure }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-4 py-3">
      <span className="text-14 font-medium text-pretty text-g-ink">{failure.problem}</span>
      <span className="text-13 text-pretty text-g-muted">{failure.recovery}</span>
    </div>
  );
}

export function DistributeSheet({
  open,
  serverUrl,
  organisation,
  onClose,
  onEnrol,
}: {
  open: boolean;
  serverUrl: string | undefined;
  organisation: string;
  onClose: () => void;
  onEnrol: () => void;
}) {
  const [route, setRoute] = React.useState<Route>("self");
  const [inputs, setInputs] = React.useState<SigningInputs>({ team: "", prefix: "", tag: "" });
  const [left, setLeft] = React.useState<Partial<Record<keyof SigningInputs, boolean>>>({});
  const problems = problemsOf(inputs);
  const complete = Object.keys(problems).length === 0;
  const commands = commandsFor(inputs, organisation);
  const shown = (key: keyof SigningInputs): string | undefined => (left[key] === true && inputs[key].trim() !== "" ? problems[key] : undefined);
  const set = (key: keyof SigningInputs) => (event: React.ChangeEvent<HTMLInputElement>) => setInputs((was) => ({ ...was, [key]: event.target.value }));
  const leave = (key: keyof SigningInputs) => () => setLeft((was) => ({ ...was, [key]: true }));
  const aria = (key: keyof SigningInputs) => {
    const error = shown(key);
    return { "aria-invalid": error === undefined ? undefined : true, "aria-describedby": error === undefined ? `distribute-${key}-hint` : `distribute-${key}-error` } as const;
  };

  return (
    <FormSheet open={open} onClose={onClose} title="Distribute Guard to your Macs" description="Sign Guard with your organisation’s Apple Developer ID and deliver it with your device-management tool.">
      <div data-testid="distribute-sheet" className="flex flex-col gap-8">
        <SheetSection title="How your Macs get Guard">
          <RadioCards<Route>
            name="distribute-route"
            label="How your Macs get Guard"
            value={route}
            onValueChange={setRoute}
            options={[
              {
                value: "self",
                title: "Sign it yourself",
                description: "Your team signs and notarizes each release. Your Macs trust your team, not Vibtra.",
                icon: PenToolIcon,
                badge: <Pill tone="ok">Available now</Pill>,
              },
              {
                value: "vibtra",
                title: "Download a Vibtra-signed copy",
                description: "Not available yet. It comes later, and this page will offer it then.",
                icon: PackageIcon,
                badge: <Pill tone="muted">Later</Pill>,
                disabled: true,
              },
            ]}
          />
        </SheetSection>

        <SheetSection
          testId="distribute-needs"
          title="What you need"
          description="Check each of these before you start. Without them the wizard stops at its first step."
          action={<DocsIconLink href={`${SELF_SIGNING_GUIDE_URL}#what-you-need-once`} label="Prerequisites" destination="Prerequisites in the self-signing guide" />}
        >
          <SheetList label="What you need" items={NEEDS} itemKey={(need) => need.id} render={(need) => <NeedRow need={need} />} />
        </SheetSection>

        <SheetSection title="Your Apple team" description="These fill in the commands below. Nothing you type here is saved or sent.">
          <FieldStack>
            <Field label="Team ID" htmlFor="distribute-team" hint={shown("team") === undefined ? "The 10 characters under Membership details at developer.apple.com." : undefined} error={shown("team")}>
              <TextInput id="distribute-team" {...aria("team")} autoComplete="off" spellCheck={false} autoCapitalize="characters" placeholder="AB12CD34EF" maxLength={10} value={inputs.team} onChange={set("team")} onBlur={leave("team")} />
            </Field>
            <Field label="Bundle ID prefix" htmlFor="distribute-prefix" hint={shown("prefix") === undefined ? "The app gets this ID and the network extension gets it plus .extension." : undefined} error={shown("prefix")}>
              <TextInput id="distribute-prefix" {...aria("prefix")} autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="com.acme.guard" value={inputs.prefix} onChange={set("prefix")} onBlur={leave("prefix")} />
            </Field>
            <Field label="Guard release tag" htmlFor="distribute-tag" hint={shown("tag") === undefined ? "The Guard release to sign, from the repository’s tags." : undefined} error={shown("tag")}>
              <TextInput id="distribute-tag" {...aria("tag")} autoComplete="off" spellCheck={false} autoCapitalize="none" placeholder="guard-v0.2.0" value={inputs.tag} onChange={set("tag")} onBlur={leave("tag")} />
            </Field>
          </FieldStack>
        </SheetSection>

        <SheetSection
          testId="distribute-commands"
          title="Sign and package"
          description="Run these in Terminal on the signing Mac. First set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_FILE to your API key’s ID, its issuer ID and the path of its .p8 file. Add --dry-run to see every step without calling Apple."
          action={<DocsIconLink href={`${SELF_SIGNING_GUIDE_URL}#sign-one-release`} label="Signing guide" destination="Signing guide: sign one release" />}
        >
          {complete ? (
            <div className="flex flex-col gap-3">
              <CodeBox label="Get the release" value={commands.clone} />
              <CodeBox label="Sign command" value={commands.sign} />
            </div>
          ) : (
            <p data-testid="distribute-incomplete" className="rounded-g-card border border-g-line bg-g-header px-4 py-3 text-14 text-g-muted">
              Enter your team ID, bundle ID prefix and release tag above, and the commands appear here.
            </p>
          )}
        </SheetSection>

        <SheetSection
          testId="distribute-deliver"
          title="Deliver it to your Macs"
          action={<DocsIconLink href={`${SELF_SIGNING_GUIDE_URL}#deliver-it-to-your-macs`} label="Delivery guide" destination="Delivery guide for Jamf Pro, Kandji and Intune" />}
        >
          <ol className="flex list-decimal flex-col gap-2 ps-5 text-14 text-pretty text-g-ink marker:text-g-muted">
            <li>
              Upload <span className="font-mono text-13 break-all">{complete ? commands.profile : "<bundle ID prefix>.mobileconfig"}</span> to your device-management tool and scope it to the Macs that run Guard. Do this first, so the network extension is already approved when Guard turns it on.
            </li>
            <li>
              Install <span className="font-mono text-13 break-all">{complete ? commands.zip : "the signed ZIP"}</span> on those Macs: unzip it and put VibtraGuard.app in Applications.
            </li>
            <li>Enrol each Mac with a one-time link for the person who uses it.</li>
          </ol>
          {serverUrl === undefined ? (
            <p data-testid="distribute-no-server" role="status" className="rounded-g-card border border-g-line bg-g-header px-4 py-3 text-14 text-g-ink">
              Unable to read this server’s address, so the enrol step cannot be shown. Close this, choose Try again on the Devices page, then open it again.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <CodeBox label="Enrol server" value={serverUrl} />
              <div>
                <ActionButton icon={LaptopIcon} onClick={onEnrol} data-testid="distribute-enrol">
                  Make an enrol link
                </ActionButton>
              </div>
            </div>
          )}
        </SheetSection>

        <SheetSection
          testId="distribute-failures"
          title="If a step fails"
          description="The wizard prints what failed and a line starting fix: with the next step. These are the common ones."
          action={<DocsIconLink href={`${SELF_SIGNING_GUIDE_URL}#if-a-step-fails`} label="Troubleshooting" destination="Troubleshooting in the self-signing guide" />}
        >
          <SheetList label="If a step fails" items={FAILURES} itemKey={(failure) => failure.id} render={(failure) => <FailureRow failure={failure} />} />
        </SheetSection>
      </div>
    </FormSheet>
  );
}

import { AppHeader } from "@/components/app-shell/app-header";
import { NewProjectWizard } from "@/components/projects/new-project-wizard";

export default function NewProjectPage() {
  return (
    <>
      <AppHeader />
      <main className="flex flex-1 flex-col">
        <NewProjectWizard />
      </main>
    </>
  );
}

import BackendStatus from "./backend-status";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-4 px-4">
      <h1 className="text-2xl font-semibold">CSE Research Hub</h1>
      <p className="opacity-75">Professor research publication management — under development.</p>
      <BackendStatus />
    </main>
  );
}

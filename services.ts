import { resolveKnownPackages } from "./known-packages";

const main = async () => {
  const knownPackages = await resolveKnownPackages("..");
  const services = [...knownPackages].filter(([, packageInfo]) => packageInfo.packageType === 'service').map(([packageName]) => packageName);

  console.log(services);
};

void main();
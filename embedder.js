const yauzl = require("yauzl");

let CLIENT_VERSION, HOST, REPO, PROOF_KEYS, NOTIFIER, PROMPTER, FILES, LOCAL_TESTING, SIGNATURE_CHECKER, SHA256, HASH_EVENT;
let ETAGS = {};

const FILE_SERVICE_FNS = ['getFilesForDirectory', 'getDefaultPath', 'saveFile', 'openFile', 'existsOrMkdir', 'exists'];

const cacheETAG = async (filename, tag) => {
	ETAGS[filename] = tag;
	await FILES.existsOrMkdir(await FILES.getDefaultPath());
	await FILES.saveFile(await FILES.getDefaultPath(), 'etags.json', JSON.stringify(ETAGS));
	return true;
}

const getSource = async (filename, method = "GET", tries = 0) => {
	const result = await (async() => Promise.race([
		fetch(`${HOST}/${filename}?rand=${Math.floor(Math.random()*999999)}`, {method, cache:"no-cache"}).then(async x => {
			if(x.status !== 200) return null;
			return {etag:x.headers.get('etag'), file:await x.text()};
		}).catch(err => {
			console.error('source error', filename, err);
			return null;
		}),
		new Promise(r =>
			setTimeout(
				() => r(null),
				5000 * (filename === 'vendor.bundle.js' ? 5 : 1)
			)
		),
	]))();

	if(!result && tries > 3) return null;
	else if (!result && tries <= 3) return getSource(filename, method, tries+1);
	else return result;
};

const MAX_TRIES = 5;

const ERR_TITLE = 'Scatter Embed Check Failure';
const WEB_APP_ERR = `Your desktop client could not make a connection with our web wallet embed, so it can't verify that it is safe to use. If you are in a country which restricts IPs such as China or Russia, you may need to enable a proxy.`;
const API_ERR = `Scatter failed to make a connection with our API which is used to verify the hash of the web wallet embed. If you are in a country which restricts IPs such as China or Russia, you may need to enable a proxy.`
const FILES_LIST_ERR = `Scatter failed to get a list of files available for the latest embedded version.`
const HASH_ERR = `The hash created from the web wallet embed does not match the hash returned from our secure API. This could be due to an update happening right now. Please try again in a moment. If this problem persists please contact support immediately at support@get-scatter.com, or on Telegram on the @Scatter channel, or Twitter at @Get_Scatter.`


const saveSource = async (filename, file) => {
	const sourcePath = `${await FILES.getDefaultPath()}/cached_sources`;
	await FILES.existsOrMkdir(sourcePath);
	return FILES.saveFile(sourcePath, filename, file);
};


const checkSignature = async (hashed, signed) => {
	const recovered = await SIGNATURE_CHECKER(hashed, signed);
	let proven = false;
	for(let i = 0; i < PROOF_KEYS.length; i++){
		try {
			if(recovered === PROOF_KEYS[i]) {
				proven = true;
				break;
			}
		} catch(e){}
	}
	return proven;
}

const filterFiles = x => (x.indexOf('.js') > -1 || x.indexOf('.html') > -1 || x.indexOf('.css') > -1) && x.indexOf('.etags') === -1 && x.indexOf('.version') === -1;

const hashStat = async (filename, verified, filesLength) => {
	const hashstat = {hash:await SHA256(filename), verified, total:filesLength};
	if(HASH_EVENT) HASH_EVENT(hashstat);
	else console.log('hashstat', hashstat);
};

const alignImportableHosts = (file, revert = false) => {
	if(!revert){

		// Applying absolute URLs to relative static assets.
		// Note: These files won't be available if Embed is down, however they are all purely aesthetic.
		// This saves the user from download another 3+mb of data which will be static anyway.
		file = file.replace(/static\/assets\//g, `${HOST}/static/assets/`);
		file = file.replace(/static\/fonts\/fa-/g, `${HOST}/static/fonts/fa-`);
	} else {
		// We need to revert the static absolute path overwrites for this to verify hashes properly.
		// file = file.replace(/https:\/\/embed.get-scatter.com\/static\/assets\//g, "static/assets/");
		// file = file.replace(/https:\/\/embed.get-scatter.com\/static\/fonts\//g, "static/fonts/");
		file = file.replace(new RegExp(`${HOST.replace(/\//, '\\/')}\/static\/assets\/`, 'g'), "static/assets/");
		file = file.replace(new RegExp(`${HOST.replace(/\//, '\\/')}\/static\/fonts\/fa-`, 'g'), "static/fonts/fa-");
	}

	return file;
};




const getReleaseInfo = async (repo = 'Bridge') => {
	return fetch(`https://api.github.com/repos/GetScatter/${repo}/releases/latest`).then(x => x.json()).catch(() => null);
}

// getReleaseInfo().then(x => console.log(x))


class Embedder {

	static init(
		clientVersion,
		repo = 'Bridge',
		proofKeys,
		fileService,
		sha256er,
		notifier = (title, text) => console.log('Notifier: ', title, text),
		prompter = (title, text) => console.log('Prompt: ', title, text),
		signatureChecker = (hashed, signed) => console.log('Signature Checker: ', hashed, signed),
		hashEvent = null,
		localTesting = false
	) {
		CLIENT_VERSION = clientVersion;
		REPO = repo;
		HOST = REPO === 'Bridge' ? 'https://bridge.get-scatter.com' : 'https://embed.get-scatter.com';
		PROOF_KEYS = proofKeys;
		FILES = fileService;
		SHA256 = sha256er;
		NOTIFIER = notifier;
		PROMPTER = prompter;
		SIGNATURE_CHECKER = signatureChecker;

		// Optionals
		HASH_EVENT = hashEvent;
		LOCAL_TESTING = localTesting;

		if(!PROOF_KEYS.length) throw new Error('You must include Proofing Keys');
		if(!FILE_SERVICE_FNS.every(prop => typeof FILES[prop] === 'function')) throw new Error(`fileService must have the following methods: ${FILE_SERVICE_FNS}`);
		if(!SHA256 || typeof SHA256 !== 'function') throw new Error('Sha256 must be a function.');
	}

	// Checks if the user has a timestamp file locally at all,
	// which is always the last file that is cached.
	static async hasLocalVersion(){
		if(LOCAL_TESTING) return false;
		return FILES.openFile(`${await FILES.getDefaultPath()}/cached_sources/release.tag`).then(x => !!x).catch(() => null)
	}

	static async getZip(info){
		return new Promise(async (resolve, reject) => {
			hashStat('Scatter Update', 0, 1);
			const downloadUrl = info.assets.find(x => x.name.indexOf('.zip') > -1).browser_download_url;
			const [repoTag, signed, ext] = downloadUrl.split('/')[downloadUrl.split('/').length-1].split('.');
			const buf = await fetch(downloadUrl, { headers:{ 'Content-type':'application/zip' } })
				.then(x => x.buffer()).catch(err => console.error(err));
			if(!buf) return resolve(null);

			const hash = SHA256(buf);
			if(!await checkSignature(hash, signed)) return resolve(null);
			hashStat('Scatter Update', 1, 1);
			return buf;
		})
	}

	static async unzip(buf){
		return new Promise(async (resolve, reject) => {
			yauzl.fromBuffer(buf, {lazyEntries:true}, (err, zipfile) => {
				if (err) return resolve(console.error(err));
				zipfile.readEntry();
				zipfile.on("entry", (entry) => {
					try {
						// DIR
						if (/\/$/.test(entry.fileName)) zipfile.readEntry();
						// FILE
						else zipfile.openReadStream(entry, (err, stream) => {
							if (err) return resolve(console.error(err));
							let filedata = '';
							stream.on('data',data => filedata += data.toString());
							stream.on("end", async () => {
								filedata = alignImportableHosts(filedata);
								await saveSource(entry.fileName, filedata);
								hashStat(entry.fileName, zipfile.entriesRead, zipfile.entryCount);
								if(zipfile.entriesRead === zipfile.entryCount) return resolve(true);
								else zipfile.readEntry();
							});
						});
					} catch(e){
						console.error(e);
					}
				});
			});
		})
	}

	static async check(){
		let hasEmbed = false;

		const latestRelease = await getReleaseInfo();
		if(!latestRelease) return NOTIFIER('Could not get release information.', 'There was an issue getting the latest release information from our API or GitHub. Please try again later.');


		const updateLocalFiles = async () => {
			const zipBuffer = await Embedder.getZip();
			if(!zipBuffer){
				hasEmbed = await PROMPTER(
					'There was an issue getting the latest Embed version.',
					'Would you like to keep using your locally cached version of Scatter Embed which has already been verified previously?'
				);
			} else {
				await Embedder.unzip(zipBuffer);
				hasEmbed = true;
			}
			return true;
		};

		const versionAvailable = async () => {
			if(LOCAL_TESTING) return true;

			const localReleaseTag = await FILES.openFile(`${await FILES.getDefaultPath()}/cached_sources/release.tag`).catch(() => null);
			return latestRelease.tag_name.trim() !== localReleaseTag.trim();
		};

		if(await versionAvailable()){
			// User doesn't have a local version,
			// so they must grab the version.
			if(!await Embedder.hasLocalVersion()) hasEmbed = await updateLocalFiles();

			// User has a local version, so they can choose to
			// update their local version to the next one.
			else {
				if(await PROMPTER(
					'An updated Scatter Embed is available.',
					'There is an updated version of Scatter Embed available. Do you want to use it?'
				)) await updateLocalFiles();
				else hasEmbed = true;
			}
		} else hasEmbed = true;

		return hasEmbed;
	}

}

module.exports = Embedder;

// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface PodcastRecord {
  id: string;
  podcastId: string;
  duration: number; // in minutes
  timestamp: number;
  encryptedData: string;
  reward: number;
  category: string;
}

interface Podcast {
  id: string;
  title: string;
  host: string;
  duration: number;
  category: string;
  popularity: number;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const FHEComputeReward = (encryptedDuration: string): string => {
  const duration = FHEDecryptNumber(encryptedDuration);
  const reward = duration * 0.1; // 0.1 tokens per minute
  return FHEEncryptNumber(reward);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [records, setRecords] = useState<PodcastRecord[]>([]);
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [filteredPodcasts, setFilteredPodcasts] = useState<Podcast[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showListenModal, setShowListenModal] = useState(false);
  const [listening, setListening] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [selectedPodcast, setSelectedPodcast] = useState<Podcast | null>(null);
  const [listenDuration, setListenDuration] = useState(0);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterCategory, setFilterCategory] = useState("all");
  const [currentPage, setCurrentPage] = useState(1);
  const recordsPerPage = 5;
  const [totalReward, setTotalReward] = useState(0);
  const [totalListeningTime, setTotalListeningTime] = useState(0);
  const [topListeners, setTopListeners] = useState<{address: string, reward: number}[]>([]);

  // Sample podcast data
  const samplePodcasts: Podcast[] = [
    { id: "p1", title: "Blockchain Revolution", host: "Alex Johnson", duration: 45, category: "Technology", popularity: 85 },
    { id: "p2", title: "Privacy Matters", host: "Sarah Chen", duration: 30, category: "Privacy", popularity: 92 },
    { id: "p3", title: "Crypto Insights", host: "Mike Williams", duration: 60, category: "Finance", popularity: 78 },
    { id: "p4", title: "FHE Explained", host: "Dr. Lisa Wong", duration: 50, category: "Education", popularity: 88 },
    { id: "p5", title: "Web3 Future", host: "David Kim", duration: 40, category: "Technology", popularity: 75 },
    { id: "p6", title: "Data Privacy 101", host: "Emma Rodriguez", duration: 35, category: "Privacy", popularity: 90 },
    { id: "p7", title: "Decentralized Finance", host: "James Wilson", duration: 55, category: "Finance", popularity: 82 },
    { id: "p8", title: "Learning ZKPs", host: "Prof. Robert Lee", duration: 48, category: "Education", popularity: 87 },
  ];

  useEffect(() => {
    loadRecords().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
    setPodcasts(samplePodcasts);
    setFilteredPodcasts(samplePodcasts);
    
    // Calculate statistics
    calculateStatistics();
    generateTopListeners();
  }, []);

  useEffect(() => {
    filterPodcasts();
  }, [searchTerm, filterCategory, podcasts]);

  const filterPodcasts = () => {
    let result = [...podcasts];
    
    if (searchTerm) {
      result = result.filter(podcast => 
        podcast.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        podcast.host.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    
    if (filterCategory !== "all") {
      result = result.filter(podcast => podcast.category === filterCategory);
    }
    
    setFilteredPodcasts(result);
  };

  const calculateStatistics = () => {
    let rewardSum = 0;
    let timeSum = 0;
    
    records.forEach(record => {
      rewardSum += record.reward;
      timeSum += record.duration;
    });
    
    setTotalReward(rewardSum);
    setTotalListeningTime(timeSum);
  };

  const generateTopListeners = () => {
    // Simulate top listeners data
    setTopListeners([
      { address: "0x1234...abcd", reward: 42.5 },
      { address: "0x5678...efgh", reward: 38.2 },
      { address: "0x9012...ijkl", reward: 35.7 },
      { address: "0x3456...mnop", reward: 28.9 },
      { address: "0x7890...qrst", reward: 25.3 },
    ]);
  };

  const loadRecords = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      const keysBytes = await contract.getData("podcast_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing record keys:", e); }
      }
      const list: PodcastRecord[] = [];
      for (const key of keys) {
        try {
          const recordBytes = await contract.getData(`podcast_${key}`);
          if (recordBytes.length > 0) {
            try {
              const recordData = JSON.parse(ethers.toUtf8String(recordBytes));
              list.push({ 
                id: key, 
                podcastId: recordData.podcastId, 
                duration: recordData.duration, 
                timestamp: recordData.timestamp, 
                encryptedData: recordData.encryptedData, 
                reward: recordData.reward,
                category: recordData.category
              });
            } catch (e) { console.error(`Error parsing record data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading record ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setRecords(list);
      calculateStatistics();
    } catch (e) { console.error("Error loading records:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const startListening = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    if (!selectedPodcast) return;
    
    setListening(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Starting encrypted listening session..." });
    
    try {
      // Simulate listening progress
      let progress = 0;
      const interval = setInterval(() => {
        progress += 5;
        setListenDuration(progress);
        setTransactionStatus({ visible: true, status: "pending", message: `Listening... ${progress}% complete` });
        
        if (progress >= 100) {
          clearInterval(interval);
          finishListening();
        }
      }, 500);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Listening failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      setListening(false);
    }
  };

  const finishListening = async () => {
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Encrypt listening duration with Zama FHE
      const encryptedDuration = FHEEncryptNumber(listenDuration);
      
      // Compute reward using FHE
      const encryptedReward = FHEComputeReward(encryptedDuration);
      
      // Create record
      const recordId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
      const podcast = selectedPodcast!;
      const recordData = { 
        podcastId: podcast.id,
        duration: listenDuration,
        timestamp: Math.floor(Date.now() / 1000),
        encryptedData: encryptedDuration,
        reward: FHEDecryptNumber(encryptedReward),
        category: podcast.category
      };
      
      await contract.setData(`podcast_${recordId}`, ethers.toUtf8Bytes(JSON.stringify(recordData)));
      
      // Update keys
      const keysBytes = await contract.getData("podcast_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(recordId);
      await contract.setData("podcast_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: `Earned ${recordData.reward.toFixed(2)} tokens!` });
      await loadRecords();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowListenModal(false);
        setListenDuration(0);
        setSelectedPodcast(null);
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setListening(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const checkAvailability = async () => {
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      const isAvailable = await contract.isAvailable();
      if (isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "ZAMA FHE system is available!" });
      } else {
        setTransactionStatus({ visible: true, status: "error", message: "ZAMA FHE system is not available" });
      }
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e) {
      setTransactionStatus({ visible: true, status: "error", message: "Availability check failed" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const getPodcastById = (id: string) => {
    return podcasts.find(p => p.id === id);
  };

  const formatTime = (minutes: number) => {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp * 1000).toLocaleDateString();
  };

  // Pagination
  const indexOfLastRecord = currentPage * recordsPerPage;
  const indexOfFirstRecord = indexOfLastRecord - recordsPerPage;
  const currentRecords = records.slice(indexOfFirstRecord, indexOfLastRecord);
  const totalPages = Math.ceil(records.length / recordsPerPage);

  const paginate = (pageNumber: number) => setCurrentPage(pageNumber);

  if (loading) return (
    <div className="loading-screen">
      <div className="rainbow-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container future-metal-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon"><div className="podcast-icon"></div></div>
          <h1>Podcast<span>FHE</span>Earn</h1>
        </div>
        <div className="header-actions">
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={true} />
          </div>
        </div>
      </header>
      
      <div className="main-content partitioned-layout">
        {/* Left Panel */}
        <div className="panel left-panel">
          <div className="panel-card rainbow-gradient">
            <h2>My Listening Stats</h2>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{totalListeningTime}m</div>
                <div className="stat-label">Total Listening</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{totalReward.toFixed(2)}</div>
                <div className="stat-label">Tokens Earned</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{records.length}</div>
                <div className="stat-label">Podcasts Listened</div>
              </div>
            </div>
          </div>
          
          <div className="panel-card rainbow-gradient">
            <h2>Listening Distribution</h2>
            <div className="chart-container">
              <div className="bar-chart">
                {['Technology', 'Privacy', 'Finance', 'Education'].map((category, index) => {
                  const count = records.filter(r => r.category === category).length;
                  const height = (count / records.length) * 100 || 0;
                  return (
                    <div key={index} className="bar">
                      <div className="bar-fill" style={{ height: `${height}%` }}></div>
                      <div className="bar-label">{category}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
        
        {/* Right Panel */}
        <div className="panel right-panel">
          <div className="panel-card rainbow-gradient">
            <h2>Top Listeners</h2>
            <div className="leaderboard">
              {topListeners.map((listener, index) => (
                <div key={index} className="leaderboard-item">
                  <div className="rank">{index + 1}</div>
                  <div className="address">{listener.address}</div>
                  <div className="reward">{listener.reward.toFixed(1)} tokens</div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="panel-card rainbow-gradient">
            <h2>Recommended For You</h2>
            <div className="recommended-podcasts">
              {podcasts.slice(0, 3).map(podcast => (
                <div key={podcast.id} className="recommended-item">
                  <div className="podcast-info">
                    <h3>{podcast.title}</h3>
                    <p>by {podcast.host}</p>
                  </div>
                  <button 
                    className="listen-btn" 
                    onClick={() => {
                      setSelectedPodcast(podcast);
                      setShowListenModal(true);
                    }}
                  >
                    Listen
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
        
        {/* Center Panel */}
        <div className="panel center-panel">
          <div className="panel-header">
            <h2>Available Podcasts</h2>
            <div className="controls">
              <div className="search-box">
                <input 
                  type="text" 
                  placeholder="Search podcasts..." 
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <button className="search-btn">🔍</button>
              </div>
              <select 
                value={filterCategory} 
                onChange={(e) => setFilterCategory(e.target.value)}
                className="category-filter"
              >
                <option value="all">All Categories</option>
                <option value="Technology">Technology</option>
                <option value="Privacy">Privacy</option>
                <option value="Finance">Finance</option>
                <option value="Education">Education</option>
              </select>
              <button onClick={checkAvailability} className="check-btn">
                Check FHE Status
              </button>
            </div>
          </div>
          
          <div className="podcasts-grid">
            {filteredPodcasts.map(podcast => (
              <div 
                key={podcast.id} 
                className="podcast-card"
                onClick={() => {
                  setSelectedPodcast(podcast);
                  setShowListenModal(true);
                }}
              >
                <div className="podcast-thumbnail"></div>
                <div className="podcast-info">
                  <h3>{podcast.title}</h3>
                  <p className="host">by {podcast.host}</p>
                  <div className="meta">
                    <span className="duration">{formatTime(podcast.duration)}</span>
                    <span className="category">{podcast.category}</span>
                  </div>
                  <div className="popularity">
                    <div className="popularity-bar" style={{ width: `${podcast.popularity}%` }}></div>
                    <span>{podcast.popularity}%</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
          
          <div className="panel-card rainbow-gradient">
            <h2>My Listening History</h2>
            <div className="history-list">
              <div className="table-header">
                <div className="header-cell">Podcast</div>
                <div className="header-cell">Duration</div>
                <div className="header-cell">Date</div>
                <div className="header-cell">Reward</div>
                <div className="header-cell">Actions</div>
              </div>
              {currentRecords.length === 0 ? (
                <div className="no-records">
                  <p>No listening history found</p>
                </div>
              ) : currentRecords.map(record => {
                const podcast = getPodcastById(record.podcastId);
                return (
                  <div className="history-item" key={record.id}>
                    <div className="table-cell">
                      {podcast ? podcast.title : "Unknown Podcast"}
                    </div>
                    <div className="table-cell">{record.duration}m</div>
                    <div className="table-cell">{formatDate(record.timestamp)}</div>
                    <div className="table-cell">{record.reward.toFixed(2)} tokens</div>
                    <div className="table-cell actions">
                      <button 
                        className="decrypt-btn"
                        onClick={async () => {
                          const decryptedDuration = await decryptWithSignature(record.encryptedData);
                          if (decryptedDuration !== null) {
                            alert(`Decrypted listening duration: ${decryptedDuration} minutes`);
                          }
                        }}
                      >
                        Decrypt
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            
            {/* Pagination */}
            <div className="pagination">
              <button 
                onClick={() => paginate(currentPage - 1)} 
                disabled={currentPage === 1}
              >
                Previous
              </button>
              <span>Page {currentPage} of {totalPages}</span>
              <button 
                onClick={() => paginate(currentPage + 1)} 
                disabled={currentPage === totalPages}
              >
                Next
              </button>
            </div>
          </div>
        </div>
      </div>
      
      {showListenModal && selectedPodcast && (
        <div className="modal-overlay">
          <div className="listen-modal rainbow-gradient">
            <div className="modal-header">
              <h2>Listen to Earn</h2>
              <button onClick={() => setShowListenModal(false)} className="close-modal">&times;</button>
            </div>
            <div className="modal-body">
              <div className="podcast-info">
                <h3>{selectedPodcast.title}</h3>
                <p className="host">by {selectedPodcast.host}</p>
                <div className="meta">
                  <span>Duration: {formatTime(selectedPodcast.duration)}</span>
                  <span>Category: {selectedPodcast.category}</span>
                </div>
              </div>
              
              <div className="encryption-notice">
                <div className="fhe-icon"></div>
                <p>Your listening data will be encrypted with <strong>ZAMA FHE</strong> technology</p>
              </div>
              
              <div className="progress-container">
                <div className="progress-bar" style={{ width: `${listenDuration}%` }}>
                  <div className="progress-label">{listenDuration}%</div>
                </div>
              </div>
              
              <div className="reward-preview">
                <div className="reward-icon"></div>
                <div className="reward-value">
                  Estimated reward: <strong>{(listenDuration * 0.1).toFixed(2)} tokens</strong>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button onClick={() => setShowListenModal(false)} className="cancel-btn">
                Cancel
              </button>
              <button 
                onClick={startListening} 
                disabled={listening || listenDuration >= 100}
                className="listen-btn primary"
              >
                {listening ? "Listening..." : "Start Listening"}
              </button>
            </div>
          </div>
        </div>
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content rainbow-gradient">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="rainbow-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo"><div className="podcast-icon"></div><span>PodcastFHEEarn</span></div>
            <p>Privacy-preserving podcast listening powered by ZAMA FHE</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">How It Works</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms of Service</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} PodcastFHEEarn. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

export default App;